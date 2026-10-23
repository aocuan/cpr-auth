// 实际控制台与协议子进程连接本机账号安全接口，验证密钥保存、批量及重启恢复
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createCredentialStore } from "../src/credential-store.mjs";
import { createRotationStore } from "../src/totp-rotation.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cpr-rotation-integration-"));
const output = path.join(root, "output");
const credentialsRoot = path.join(root, "credentials");
const store = createCredentialStore({ macRoot: credentialsRoot, windowsRoot: path.join(root, "CPR Auth", "credentials"), linuxRoot: credentialsRoot });
const journal = createRotationStore(path.join(output, "totp-rotations"));
const oldSecret = "NB2W45DFOIZAQWER", newSecret = "JBSWY3DPEHPK3PXP";
const accounts = new Map();
const oldFactor = { id: "old", factor_type: "totp", is_recovery: false };
const newFactor = { ...oldFactor, id: "new" };
let holdActivation = false;
let resolveActivation;
let resolveDisconnected;
let activationArrived;
let child, exited, base, headers, logs = "";
const mock = http.createServer(async (req, res) => {
  const account = accounts.get(/fixture=([^;]+)/.exec(req.headers.cookie || "")?.[1]);
  const json = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (!account) return json({}, 401);
  if (req.url === "/api/auth/session") return json({ user: { email: account.email }, accessToken: "synthetic-token", account: { id: "synthetic-account" } });
  if (req.headers.authorization !== "Bearer synthetic-token") return json({}, 401);
  if (req.url.endsWith("/mfa_info")) return json({ mfa_enabled: account.factors.length > 0, factors: { totp: account.factors } });
  let body = ""; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body || "{}");
  if (req.url.endsWith("/disable_in_house")) {
    assert.equal(payload.factor_id, "old"); account.disable++; account.factors = []; return json({ message: "Factor disabled" });
  }
  if (req.url.endsWith("/mfa/enroll")) {
    account.enroll++; if (account.loseEnrollment) { req.socket.destroy(); return; } return json({ secret: newSecret, session_id: "synthetic-enrollment", factor: newFactor });
  }
  if (req.url.endsWith("/activate_enrollment")) {
    assert.match(payload.code, /^\d{6}$/); account.activate++; account.factors = [newFactor];
    if (holdActivation) { req.socket.once("close", () => resolveDisconnected?.()); resolveActivation(); return; }
    if (account.disconnect) { req.socket.destroy(); return; }
    return json({ success: true });
  }
  json({}, 404);
});
await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
const mockBase = `http://127.0.0.1:${mock.address().port}`;
async function fixture(name, enabled = true) {
  const id = crypto.randomUUID(), email = `${name}-${id.slice(0, 8)}@example.com`, dir = path.join(output, id);
  const account = { id, email, factors: enabled ? [oldFactor] : [], disable: 0, enroll: 0, activate: 0 };
  accounts.set(name, account);
  await fs.mkdir(dir, { recursive: true });
  await store.save(email, { password: "Synthetic_Password_123!", totpSecret: enabled ? oldSecret : "" });
  await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", result_saved: true, has_totp_key: enabled, has_password: true, login_mode: "password" }));
  await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email }, extra: { email } }] }));
  await fs.writeFile(path.join(dir, "login-checkpoint.json"), JSON.stringify({ version: 1, email, stage: "email_verified", cookies: [{ name: "fixture", value: name, domain: "127.0.0.1", path: "/", secure: false, hostOnly: true }] }));
  return account;
}
async function start() {
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/console-server.mjs", "--port", String(port)], { env: { ...process.env,
    NODE_ENV: "production", ONBOARDING_OUTPUT_ROOT: output, TOSUB2_MAC_CREDENTIAL_ROOT: credentialsRoot,
    CPR_AUTH_CREDENTIAL_ROOT: credentialsRoot, LOCALAPPDATA: root, CHATGPT_BASE: mockBase, AUTH_BASE: mockBase,
    TOSUB2_TLS_PROFILE: "chrome142", ONBOARDING_PROTOCOL_SCRIPT: path.resolve("src/protocol-login.mjs"),
  }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  exited = new Promise(resolve => child.once("exit", resolve));
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  for (let i = 0; i < 120; i++) {
    try { const response = await fetch(base + "/api/bootstrap"); if (response.ok) { headers = { "x-console-token": (await response.json()).token, "content-type": "application/json" }; return; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`console startup failed: ${logs}`);
}
async function stop() { if (child?.connected) child.send("shutdown"); await exited; }
async function api(route, body) {
  const response = await fetch(base + route, { headers, ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const data = await response.json(); return { response, data };
}
async function waitJob(account, predicate) {
  for (let i = 0; i < 180; i++) {
    const { data } = await api("/api/jobs"); const job = data.jobs.find(j => j.id === account.id);
    if (job && predicate(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const { data } = await api("/api/jobs");
  throw new Error(`job timeout ${JSON.stringify(data.jobs)} ${logs}`);
}
try {
  const single = await fixture("single"), batch = await fixture("batch"), noKey = await fixture("nokey", false), unknown = await fixture("unknown"), crash = await fixture("crash");
  const manual = await fixture("manual"); manual.loseEnrollment = true;
  unknown.disconnect = true;
  await start();
  const duplicate = await Promise.all([api(`/api/jobs/${single.id}/rotate-2fa`, {}), api(`/api/jobs/${single.id}/rotate-2fa`, {})]);
  assert.deepEqual(duplicate.map(result => result.response.status).sort(), [200, 409]);
  await waitJob(single, job => job.totpRotation?.phase === "committed");
  assert.equal((await store.load(single.email)).totpSecret, newSecret);
  assert.equal(single.disable, 1); assert.equal(single.activate, 1);
  const exported = await fetch(base + "/api/jobs/export-source", { method: "POST", headers, body: JSON.stringify({ ids: [single.id] }) });
  assert.equal(exported.status, 200);
  assert.ok((await exported.text()).includes(newSecret));
  // 公开轮询不泄漏密钥
  const snapshot = await api("/api/jobs"); assert.ok(!JSON.stringify(snapshot.data).includes(newSecret));
  const batchResult = await api("/api/jobs/rotate-2fa-batch", { ids: [batch.id, noKey.id] });
  assert.equal(batchResult.data.started, 1); assert.equal(batchResult.data.skipped, 1);
  await waitJob(batch, job => job.totpRotation?.phase === "committed");
  await api(`/api/jobs/${unknown.id}/rotate-2fa`, {});
  await waitJob(unknown, job => job.status === "failed" && job.canRecoverTotp);
  assert.equal((await api(`/api/jobs/${unknown.id}/relogin`, {})).response.status, 409);
  assert.equal((await api(`/api/jobs/${unknown.id}/rotate-2fa`, {})).response.status, 409);
  const singleMetadataPath = path.join(output, single.id, "job-meta.json");
  const singleMetadata = JSON.parse(await fs.readFile(singleMetadataPath, "utf8"));
  await fs.writeFile(singleMetadataPath, JSON.stringify({ ...singleMetadata, status: "starting", prompt: "stale state" }));
  await fs.writeFile(path.join(output, single.id, "totp-setup-result.json"), JSON.stringify({
    version: 1, email: single.email, activation_succeeded: true, secret: oldSecret, activated_at: "2020-01-01T00:00:00.000Z",
  }));
  await stop(); await start();
  assert.equal((await store.load(single.email)).totpSecret, newSecret);
  const restoredSingle = await waitJob(single, job => job.totpRotation?.phase === "committed");
  assert.equal(restoredSingle.status, "completed");
  assert.match(restoredSingle.prompt, /新密钥已安全保存/);
  await api(`/api/jobs/${unknown.id}/recover-2fa`, {});
  await waitJob(unknown, job => job.totpRotation?.phase === "committed");
  assert.equal((await store.load(unknown.email)).totpSecret, newSecret);
  assert.equal(unknown.disable, 1); assert.equal(unknown.activate, 1);
  await api(`/api/jobs/${manual.id}/rotate-2fa`, {});
  await waitJob(manual, job => job.canRecoverTotp);
  const beforeManual = { disable: manual.disable, enroll: manual.enroll, activate: manual.activate };
  assert.equal((await api(`/api/jobs/${manual.id}/recover-2fa`, { currentTotpSecret: newSecret })).response.status, 400);
  assert.equal((await api(`/api/jobs/${manual.id}/recover-2fa`, { currentTotpSecret: newSecret, confirmedCurrentKey: true })).response.status, 200);
  const manualJob = await waitJob(manual, job => job.totpRotation?.phase === "reconciled");
  assert.match(manualJob.prompt, /人工核实/);
  assert.equal((await store.load(manual.email)).totpSecret, newSecret);
  assert.deepEqual({ disable: manual.disable, enroll: manual.enroll, activate: manual.activate }, beforeManual);
  // 激活已到达服务端但响应悬挂，强制杀死控制台后，协议子进程随 IPC 断开退出
  const disconnected = new Promise(resolve => { resolveDisconnected = resolve; });
  holdActivation = true; activationArrived = new Promise(resolve => { resolveActivation = resolve; });
  await api(`/api/jobs/${crash.id}/rotate-2fa`, {});
  await Promise.race([activationArrived, new Promise((_, reject) => setTimeout(() => reject(new Error("activation timeout")), 5000))]);
  child.kill("SIGKILL"); await exited;
  await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error("orphan protocol process")), 5000))]);
  holdActivation = false;
  await start();
  await api(`/api/jobs/${crash.id}/recover-2fa`, {});
  await waitJob(crash, job => job.totpRotation?.phase === "committed");
  assert.equal(crash.activate, 1); assert.equal(crash.disable, 1);
  assert.equal((await store.load(crash.email)).totpSecret, newSecret);
  for (const name of await fs.readdir(path.join(output, "totp-rotations"))) {
    if (!name.endsWith(".json")) continue;
    const data = await fs.readFile(path.join(output, "totp-rotations", name), "utf8");
    assert.ok(!data.includes(newSecret)); assert.ok(!data.includes("synthetic-token"));
  }
  assert.equal((await journal.load(crash.email)).cookies, undefined);
  console.log("TOTP console/protocol integration: single, batch, encrypted credentials, interrupted activation and restart recovery passed");
} finally {
  await stop().catch(() => {});
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  for (const account of accounts.values()) await store.delete(account.email);
  await fs.rm(root, { recursive: true, force: true });
}
