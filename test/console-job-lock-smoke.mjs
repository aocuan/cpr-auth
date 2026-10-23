import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-console-lock-"));
const port = await findAvailablePort();
const mailboxPort = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const mailboxUrl = `http://127.0.0.1:${mailboxPort}/messages`;
let latestMailboxRequest = null;
let releaseMailbox = null;
const mailbox = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  latestMailboxRequest = {
    method: req.method,
    authorization: req.headers.authorization,
    body: Buffer.concat(chunks).toString("utf8"),
  };
  if (latestMailboxRequest.body.includes("delete-before-launch")) {
    await new Promise(resolve => { releaseMailbox = resolve; });
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("[]");
});
await new Promise((resolve) => mailbox.listen(mailboxPort, "127.0.0.1", resolve));

const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-queue-protocol.mjs"),
    TOSUB2_TLS_PROFILE: "chrome142",
    MOCK_QUEUE_LAUNCH_LOG: path.join(outputRoot, "launches.log"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let consoleLogs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
const childExit = new Promise((resolve) => child.once("exit", resolve));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const mailConfigResponse = await fetch(`${baseUrl}/api/mail-request-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: {
      method: "POST",
      url: mailboxUrl,
      headers: { Authorization: "Bearer mailbox-test-token", "Content-Type": "application/json" },
    } }),
  });
  assert.equal(mailConfigResponse.status, 200, await mailConfigResponse.text());
  const requests = Array.from({ length: 10 }, () => fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "same-email@example.com" }),
  }));
  const responses = await Promise.all(requests);
  const payloads = await Promise.all(responses.map((response) => response.json()));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(new Set(payloads.map((payload) => payload.job.id)).size, 1);

  const jobId = payloads[0].job.id;
  await waitForJob(headers, jobId, (job) => job.status === "email_otp");
  const updateResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "same-email@example.com",
      mailRequestBody: '{"mailbox_id":"same-email-mailbox"}',
    }),
  });
  assert.equal(updateResponse.status, 200, await updateResponse.text());
  await waitForJob(headers, jobId, (job) => job.attempt === 2 && job.status === "email_otp");
  await waitFor(() => latestMailboxRequest?.body === '{"mailbox_id":"same-email-mailbox"}');
  assert.equal(latestMailboxRequest.method, "POST");
  assert.equal(latestMailboxRequest.authorization, "Bearer mailbox-test-token");

  const logsAfterRestart = await (await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers })).json();
  assert.equal(countOccurrences(logsAfterRestart.logs, "Mock queued login started"), 2);

  const unchangedResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "same-email@example.com",
      mailRequestBody: '{"mailbox_id":"same-email-mailbox"}',
    }),
  });
  assert.equal(unchangedResponse.status, 200, await unchangedResponse.text());
  await delay(300);
  const unchangedLogs = await (await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers })).json();
  assert.equal(countOccurrences(unchangedLogs.logs, "Mock queued login started"), 2);

  const page = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  assert.equal(page.pagination.total, 1);
  const cancelResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: "POST", headers, body: "{}" });
  assert.equal(cancelResponse.status, 200, await cancelResponse.text());
  await waitForJob(headers, jobId, (job) => job.status === "canceled");

  const reloginResponses = await Promise.all(Array.from({ length: 2 }, () => fetch(`${baseUrl}/api/jobs/${jobId}/relogin`, {
    method: "POST",
    headers,
    body: "{}",
  })));
  assert.equal(reloginResponses.filter((response) => response.status === 200).length, 1);
  assert.equal(reloginResponses.filter((response) => response.status === 409).length, 1);
  const reloginJob = await waitForJob(headers, jobId, (job) => job.attempt === 3 && job.status === "email_otp");
  assert.equal(reloginJob.attempt, 3, "concurrent relogin requests must increment the attempt only once");
  const logsAfterConcurrentRelogin = await (await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers })).json();
  assert.equal(countOccurrences(logsAfterConcurrentRelogin.logs, "Mock queued login started"), 3);
  await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: "POST", headers, body: "{}" });

  const delayedResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST", headers,
    body: JSON.stringify({ email: "deleted-before-launch@example.com", mailRequestBody: '{"mailbox_id":"delete-before-launch"}' }),
  });
  assert.equal(delayedResponse.status, 201);
  const delayedJob = (await delayedResponse.json()).job;
  await waitFor(() => releaseMailbox !== null);
  const removeDelayed = await fetch(`${baseUrl}/api/jobs/delete-batch`, {
    method: "POST", headers, body: JSON.stringify({ ids: [delayedJob.id] }),
  });
  assert.equal(removeDelayed.status, 200, await removeDelayed.text());
  releaseMailbox();
  releaseMailbox = null;
  await delay(800);
  const launches = await fs.readFile(path.join(outputRoot, "launches.log"), "utf8");
  assert.equal(launches.includes("deleted-before-launch@example.com"), false, "删除后完成的邮件预检查不得启动授权子进程");

  // 模拟删除完成后迟到的产物，输出扫描不得再次恢复被删除的任务
  const lateId = "11111111-1111-4111-8111-111111111111";
  const lateDirectory = path.join(outputRoot, lateId);
  async function writeLateOutput() {
    await fs.mkdir(lateDirectory, { recursive: true });
    await fs.writeFile(path.join(lateDirectory, "sub2api-import-oauth.json"), JSON.stringify({
      type: "sub2api-data", accounts: [{ name: "late-output@example.com", credentials: { email: "late-output@example.com", access_token: "fixture" } }],
    }));
  }
  await writeLateOutput();
  await waitForJob(headers, lateId, job => job.status === "completed");
  const removeLate = await fetch(`${baseUrl}/api/jobs/delete-batch`, {
    method: "POST", headers, body: JSON.stringify({ ids: [lateId] }),
  });
  assert.equal(removeLate.status, 200, await removeLate.text());
  await writeLateOutput();
  await delay(2100);
  const afterLate = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  assert.equal(afterLate.jobs.some(job => job.id === lateId), false, "迟到的产物不得复活已删除任务");
  console.log("console job lock tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${consoleLogs}`;
  throw error;
} finally {
  releaseMailbox?.();
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await new Promise((resolve) => mailbox.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`console exited before startup with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`console did not start at ${url}`);
}

async function waitForJob(headers, jobId, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers });
    const page = await response.json();
    const job = page.jobs.find((item) => item.id === jobId);
    if (job && predicate(job)) return job;
    await delay(100);
  }
  throw new Error(`job ${jobId} did not reach the expected state`);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error("condition did not become true before timeout");
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function countOccurrences(value, needle) {
  return String(value || "").split(needle).length - 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
