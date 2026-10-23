import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCredentialStore } from "../src/credential-store.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-credentials-"));

try {
  const powerShellRunner = async (script, input) => {
    assert.ok(script.includes('cpr-auth.credentials.v1'), "使用独立应用的 DPAPI 用途标识");
    if (script.includes("ProtectedData]::Protect")) {
      return { code: 0, stdout: Buffer.from(input, "utf8").toString("base64"), stderr: "" };
    }
    if (script.includes("ProtectedData]::Unprotect")) {
      return { code: 0, stdout: Buffer.from(input.trim(), "base64").toString("utf8"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected script" };
  };
  const store = createCredentialStore({ platform: "win32", windowsRoot: tempRoot, powerShellRunner });
  const email = "Windows.User@example.com";
  const credentials = {
    password: "test-password",
    totpSecret: "JBSWY3DPEHPK3PXP",
    proxyUrl: "socks5h://user:secret@proxy.example:5000",
  };

  assert.deepEqual(await store.load(email), { password: "", totpSecret: "", proxyUrl: "" });
  await store.save(email, credentials);
  assert.deepEqual(await store.load(email.toLowerCase()), credentials);

  const updatedCredentials = {
    password: "更新后的密码",
    totpSecret: "NB2W45DFOIZAQWER",
    proxyUrl: "http://updated:secret@proxy.example:8080",
  };
  await store.save(email, updatedCredentials);
  assert.deepEqual(await store.load(email), updatedCredentials);

  const storedFiles = await fs.readdir(tempRoot);
  assert.equal(storedFiles.length, 1);
  const encryptedAtRest = await fs.readFile(path.join(tempRoot, storedFiles[0]), "utf8");
  assert.equal(encryptedAtRest.includes(updatedCredentials.password), false);
  assert.equal(encryptedAtRest.includes(updatedCredentials.proxyUrl), false);

  await store.delete(email);
  assert.deepEqual(await store.load(email), { password: "", totpSecret: "", proxyUrl: "" });

  if (process.platform === "win32") {
    const realStore = createCredentialStore({ windowsRoot: path.join(tempRoot, "real-dpapi") });
    await realStore.save(email, credentials);
    assert.deepEqual(await realStore.load(email), credentials);
    await realStore.delete(email);
    assert.deepEqual(await realStore.load(email), { password: "", totpSecret: "", proxyUrl: "" });
  }

  let macKey = "";
  const macStore = createCredentialStore({
    platform: "darwin",
    macRoot: path.join(tempRoot, "mac"),
    securityRunner: async (args, input = "") => {
      assert.equal(args[args.indexOf("-s") + 1], "com.local.cpr-auth.credentials", "不得访问原 toSub2 的钥匙串条目");
      if (args[0] === "add-generic-password") {
        assert.equal(args.at(-1), "-w");
        assert.equal(args.some((value) => value.includes(credentials.password)), false);
        const enteredKeys = input.trim().split(/\r?\n/);
        assert.equal(enteredKeys.length, 2);
        assert.equal(enteredKeys[0], enteredKeys[1]);
        macKey = enteredKeys[0];
        assert.equal(Buffer.from(macKey, "base64").length, 32);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") return { code: 0, stdout: macKey, stderr: "" };
      if (args[0] === "delete-generic-password") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });
  await macStore.save(email, credentials);
  assert.deepEqual(await macStore.load(email), credentials);
  await macStore.delete(email);

  const truncatedPayload = JSON.stringify({
    version: 2,
    password: credentials.password,
    totpSecret: credentials.totpSecret,
    proxyUrl: credentials.proxyUrl.repeat(5),
  }).slice(0, 128);
  const legacyMacStore = createCredentialStore({
    platform: "darwin",
    macRoot: path.join(tempRoot, "legacy-mac"),
    securityRunner: async (args) => (
      args[0] === "find-generic-password"
        ? { code: 0, stdout: truncatedPayload, stderr: "" }
        : { code: 0, stdout: "", stderr: "" }
    ),
  });
  assert.deepEqual(await legacyMacStore.load(email), {
    password: credentials.password,
    totpSecret: credentials.totpSecret,
    proxyUrl: "",
  });

  const linuxRoot = path.join(tempRoot, "linux");
  const linuxStore = createCredentialStore({ platform: "linux", linuxRoot });
  assert.deepEqual(await linuxStore.load(email), { password: "", totpSecret: "", proxyUrl: "" });
  await Promise.all(Array.from({ length: 12 }, (_, index) => linuxStore.save(`linux-${index}@example.com`, credentials)));
  await linuxStore.save(email, credentials);
  const reopened = createCredentialStore({ platform: "linux", linuxRoot });
  assert.deepEqual(await reopened.load(email.toLowerCase()), credentials);
  const linuxFiles = (await fs.readdir(linuxRoot)).filter(name => name.endsWith(".json"));
  assert.equal(linuxFiles.length, 13);
  const firstPath = path.join(linuxRoot, linuxFiles[0]);
  const encrypted = await fs.readFile(firstPath, "utf8");
  assert.equal(encrypted.includes(credentials.password), false);
  assert.equal(encrypted.includes(credentials.proxyUrl), false);
  if (process.platform !== "win32") assert.equal((await fs.stat(firstPath)).mode & 0o777, 0o600);
  await linuxStore.save("bound@example.com", credentials);
  const boundFile = (await fs.readdir(linuxRoot)).find(name => name.endsWith(".json") && !linuxFiles.includes(name));
  await fs.writeFile(path.join(linuxRoot, boundFile), encrypted);
  await assert.rejects(reopened.load("bound@example.com"), /无法解密/);
  const keyPath = path.join(linuxRoot, "credential-key");
  const originalKey = await fs.readFile(keyPath);
  await fs.writeFile(keyPath, "invalid-key");
  await assert.rejects(reopened.load(email), /密钥无效/);
  await assert.rejects(reopened.save(email, updatedCredentials), /密钥无效/);
  assert.equal(await fs.readFile(keyPath, "utf8"), "invalid-key");
  await fs.unlink(keyPath);
  await assert.rejects(reopened.load(email), /密钥缺失/);
  await assert.rejects(reopened.save(email, updatedCredentials), /密钥缺失/);
  await assert.rejects(fs.access(keyPath), error => error.code === "ENOENT");
  await fs.writeFile(keyPath, originalKey, { mode: 0o600 });
  assert.deepEqual(await reopened.load(email), credentials);
  await reopened.delete(email);
  assert.deepEqual(await reopened.load(email), { password: "", totpSecret: "", proxyUrl: "" });

  // 模拟批量恢复凭据：子进程资源受限，单次失败不能阻塞后续队列
  let active = 0;
  let peak = 0;
  let calls = 0;
  const boundedStore = createCredentialStore({
    platform: "win32",
    windowsRoot: path.join(tempRoot, "bounded"),
    powerShellRunner: async (_script, input) => {
      const call = calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (call === 0) throw new Error("simulated process failure");
      return { code: 0, stdout: Buffer.from(input).toString("base64"), stderr: "" };
    },
  });
  const results = await Promise.allSettled(Array.from({ length: 32 }, (_, index) =>
    boundedStore.save(`batch-${index}@example.com`, credentials)));
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(calls, 32, "失败后仍应处理所有等待任务");
  assert.ok(peak <= 8, `凭据子进程并发失控：${peak}`);
  assert.equal(active, 0);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("credential store tests passed");
