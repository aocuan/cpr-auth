import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCredentialStore } from "../src/credential-store.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-console-"));
const sourceCredentials = createCredentialStore({
  macRoot: path.join(outputRoot, "test-mac-credentials"),
  linuxRoot: path.join(outputRoot, "credentials"),
  windowsRoot: path.join(outputRoot, "app-data", "CPR Auth", "credentials"),
});
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const cprPort = await findAvailablePort();
const cprUrl = `http://127.0.0.1:${cprPort}`;
let importedItems = [];
const cpr = http.createServer(async (req, res) => {
  const reply = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ code: 200, data })); };
  if (req.headers["x-api-key"] !== "test-admin-key") return reply(null, 401);
  if (req.url.startsWith("/api/admin/account-groups/options")) return reply({ items: [{ id: "grp_test", name: "测试组", enabled: true }] });
  if (req.url.startsWith("/api/admin/proxies")) return reply({ items: [] });
  if (req.method === "POST" && req.url === "/api/admin/accounts/import-tasks") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    importedItems.push(...JSON.parse(raw).items);
    return reply({ taskId: `task_${importedItems.length}` }, 202);
  }
  if (req.url.startsWith("/api/admin/accounts/import-tasks/detail")) return reply({ total: 1, finishedAt: new Date().toISOString(), items: [{ status: "succeeded", accountIds: ["acct_test"] }] });
  reply(null, 404);
});
await new Promise(resolve => cpr.listen(cprPort, "127.0.0.1", resolve));
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
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs"),
    TOSUB2_TLS_PROFILE: "chrome142",
    PROXY_CONNECTION_RETRY_BASE_MS: "1",
    SUB2API_AUTO_REPAIR_COOLDOWN_MS: "0",
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
    LOCALAPPDATA: path.join(outputRoot, "app-data"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let logs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  assert.equal(typeof bootstrap.token, "string");
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };

  const pageResponse = await fetch(`${baseUrl}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") || "", /text\/html;\s*charset=utf-8/i);

  const mailRequestConfigResponse = await fetch(`${baseUrl}/api/mail-request-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: {
      method: "POST",
      url: `${baseUrl}/api/bootstrap`,
      headers: { Authorization: "Bearer private-mail-token", Referer: "https://mail.example/private" },
    } }),
  });
  const mailRequestConfigText = await mailRequestConfigResponse.text();
  assert.equal(mailRequestConfigResponse.status, 200, mailRequestConfigText);
  assert.deepEqual(JSON.parse(mailRequestConfigText).config, {
    method: "POST",
    urlConfigured: true,
    headerCount: 2,
  });

  const postMailSourceLines = [
    "post-body@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9",
    "post-password@example.com----test-password----opaque-account-body",
    '{"mailbox_id":"id-c"}----post-unordered@example.com----test-password-c',
  ];
  const postMailBatchResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: postMailSourceLines.join("\n") }),
  });
  const postMailBatchText = await postMailBatchResponse.text();
  assert.equal(postMailBatchResponse.status, 201, postMailBatchText);
  const postMailBatch = JSON.parse(postMailBatchText);
  assert.equal(postMailBatch.jobs.length, 3);
  assert.equal(postMailBatch.jobs.find((job) => job.email === "post-body@example.com").loginMode, "email_otp");
  assert.equal(postMailBatch.jobs.find((job) => job.email === "post-password@example.com").loginMode, "password");
  assert.equal(postMailBatch.jobs.find((job) => job.email === "post-unordered@example.com").loginMode, "password");
  postMailBatch.jobs.forEach((job) => assert.equal(job.autoEmailOtp, true));

  const postMailSourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: postMailBatch.jobs.map((job) => job.id) }),
  });
  const postMailSourceText = await postMailSourceResponse.text();
  assert.equal(postMailSourceResponse.status, 200, postMailSourceText);
  const postMailSourceExport = postMailSourceText.replace(/^\uFEFF/, "").trim().split("\n").sort();
  assert.deepEqual(postMailSourceExport, [
    "post-body@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9",
    "post-password@example.com----test-password----opaque-account-body",
    'post-unordered@example.com----test-password-c----{"mailbox_id":"id-c"}',
  ].sort());

  const deletePostMailJobsResponse = await fetch(`${baseUrl}/api/jobs/delete-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: postMailBatch.jobs.map((job) => job.id) }),
  });
  assert.equal(deletePostMailJobsResponse.status, 200, await deletePostMailJobsResponse.text());

  await verifySourceExport(headers, {
    email: "source-post-base32@example.com", password: "aBCD2345eFGH6723",
    mailRequestBody: '{"mailbox_id":"synthetic"}', totpSecret: "JBSWY3DPEHPK3PXP",
  }, 200);
  await verifySourceExport(headers, {
    email: "source-post-multiline@example.com", password: "test-password",
    mailRequestBody: '{\n"mailbox_id":"synthetic"\n}',
  }, 409);

  const forbiddenMailHeaderResponse = await fetch(`${baseUrl}/api/mail-request-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: { method: "GET", headers: { Host: "mail.example" } } }),
  });
  assert.equal(forbiddenMailHeaderResponse.status, 400, await forbiddenMailHeaderResponse.text());

  const resetMailRequestConfigResponse = await fetch(`${baseUrl}/api/mail-request-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: { method: "GET", headers: {} } }),
  });
  assert.equal(resetMailRequestConfigResponse.status, 200, await resetMailRequestConfigResponse.text());

  for (const [suffix, fields, status] of [
    ["ordinary", { password: "普通-password", totpSecret: "JBSWY3DPEHPK3PXP" }, 200],
    ["base32-mail-totp", { password: "aBCD2345eFGH6723", mailApiUrl: `${baseUrl}/api/bootstrap`, totpSecret: "JBSWY3DPEHPK3PXP" }, 200],
    ["leading-hyphen", { password: "-password", totpSecret: "JBSWY3DPEHPK3PXP" }, 409],
    ["trailing-hyphen", { password: "password-", totpSecret: "JBSWY3DPEHPK3PXP" }, 409],
    ["edge-spaces", { password: " password " }, 409],
    ["url-delimiter", { password: "password", mailApiUrl: `${baseUrl}/api/bootstrap?token=a----b`, totpSecret: "JBSWY3DPEHPK3PXP" }, 409],
  ]) {
    await verifySourceExport(headers, { email: `source-${suffix}@example.com`, ...fields }, status);
  }

  const createdResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "cross-platform@example.com" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.created, true);
  assert.equal(created.job.lastOperationType, "initial_authorization");
  assert.ok(Date.parse(created.job.lastOperationAt));
  const jobId = created.job.id;

  let job = await waitForJob(headers, jobId, (value) => value.status === "completed");
  assert.equal(job.canDownload, true);

  const downloadResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/download`, { headers });
  assert.equal(downloadResponse.status, 200);
  const download = await downloadResponse.json();
  assert.equal(download.type, "sub2api-data");
  assert.equal(download.accounts?.[0]?.credentials?.email, "cross-platform@example.com");

  const regenerateResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/regenerate`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(regenerateResponse.status, 200);
  job = await waitForJob(headers, jobId, (value) => value.status === "completed" && value.attempt >= 2);
  assert.equal(job.canDownload, true);
  assert.equal(job.lastOperationType, "reauthorize");

  const refreshedResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/download`, { headers });
  const refreshed = await refreshedResponse.json();
  assert.match(refreshed.accounts?.[0]?.credentials?.access_token || "", /^refreshed-access-/);

  const profileResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "account-profile@example.com" }),
  });
  assert.equal(profileResponse.status, 201);
  const profileCreated = await profileResponse.json();
  const profileJob = await waitForJob(headers, profileCreated.job.id, (value) => value.status === "completed");
  assert.equal(profileJob.canDownload, true);

  const setupTotpResponse = await fetch(`${baseUrl}/api/jobs/${profileJob.id}/setup-2fa`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(setupTotpResponse.status, 200, await setupTotpResponse.text());
  const totpCompleted = await waitForJob(
    headers,
    profileJob.id,
    (value) => value.status === "completed" && value.hasTotpKey,
  );
  assert.equal(totpCompleted.canDownload, true);
  assert.equal(totpCompleted.lastOperationType, "setup_2fa");
  assert.equal(totpCompleted.totpSetupSecret, null);
  const setupLogs = await fetch(`${baseUrl}/api/jobs/${profileJob.id}/logs`, { headers }).then((response) => response.json());
  assert.match(setupLogs.logs, /Generated a current 6-digit activation code/);
  assert.doesNotMatch(setupLogs.logs, /NB2W45DFOIZAQWER/);
  const downloadAfterTotp = await fetch(`${baseUrl}/api/jobs/${profileJob.id}/download`, { headers });
  assert.equal(downloadAfterTotp.status, 200);

  const batchTotpResponse = await fetch(`${baseUrl}/api/jobs/setup-2fa-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId, profileJob.id] }),
  });
  const batchTotpText = await batchTotpResponse.text();
  assert.equal(batchTotpResponse.status, 200, batchTotpText);
  const batchTotp = JSON.parse(batchTotpText);
  assert.equal(batchTotp.started, 1);
  assert.equal(batchTotp.skipped, 1);
  await waitForJob(headers, jobId, (value) => value.status === "completed" && value.hasTotpKey);
  const updatedSourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId] }),
  });
  assert.equal(updatedSourceResponse.status, 200);
  assert.equal(
    (await updatedSourceResponse.text()).replace(/^\uFEFF/, "").trim(),
    "cross-platform@example.com--------NB2W45DFOIZAQWER",
  );
  const reimportUpdatedSourceResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "cross-platform@example.com--------NB2W45DFOIZAQWER" }),
  });
  const reimportUpdatedSourceText = await reimportUpdatedSourceResponse.text();
  assert.equal(reimportUpdatedSourceResponse.status, 201, reimportUpdatedSourceText);
  const reimportUpdatedSource = JSON.parse(reimportUpdatedSourceText);
  assert.equal(reimportUpdatedSource.jobs[0].email, "cross-platform@example.com");
  assert.equal(reimportUpdatedSource.created, 0);
  assert.equal(reimportUpdatedSource.updated, 1);
  assert.equal(reimportUpdatedSource.jobs[0].hasTotpKey, true);

  const reloginResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/relogin`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(reloginResponse.status, 200, await reloginResponse.text());
  const reloggedJob = await waitForJob(
    headers,
    jobId,
    (value) => value.status === "completed" && value.canForceRelogin,
  );
  assert.equal(reloggedJob.hasTotpKey, true);
  assert.equal(reloggedJob.lastOperationType, "relogin");
  const reloginLogs = await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers }).then((response) => response.json());
  assert.match(reloginLogs.logs, /\[relogin\].*跳过刷新令牌并强制重新登录/);

  const mfaPromptResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "mfa-prompt@example.com" }),
  });
  assert.equal(mfaPromptResponse.status, 201);
  const mfaPromptJobId = (await mfaPromptResponse.json()).job.id;
  const mfaPromptJob = await waitForJob(headers, mfaPromptJobId, (value) => value.status === "mfa_otp");
  assert.equal(mfaPromptJob.prompt, "请输入 6 位 2FA 验证码");
  const mfaInputResponse = await fetch(`${baseUrl}/api/jobs/${mfaPromptJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "mfa_otp", value: "123456" }),
  });
  assert.equal(mfaInputResponse.status, 200, await mfaInputResponse.text());
  await waitForJob(headers, mfaPromptJobId, (value) => value.status === "completed");

  const wrongEmailOtpResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "wrong-email-otp-console@example.com" }),
  });
  assert.equal(wrongEmailOtpResponse.status, 201);
  const wrongEmailOtpJobId = (await wrongEmailOtpResponse.json()).job.id;
  await waitForJob(headers, wrongEmailOtpJobId, (value) => value.status === "email_otp");
  const wrongEmailOtpInput = await fetch(`${baseUrl}/api/jobs/${wrongEmailOtpJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "email_otp", value: "000000" }),
  });
  assert.equal(wrongEmailOtpInput.status, 200, await wrongEmailOtpInput.text());
  const retryEmailOtpJob = await waitForJob(
    headers,
    wrongEmailOtpJobId,
    (value) => value.status === "email_otp" && /验证码错误/.test(value.prompt || ""),
  );
  assert.equal(retryEmailOtpJob.prompt, "邮箱验证码错误，请重新输入或重新发送");
  const correctEmailOtpInput = await fetch(`${baseUrl}/api/jobs/${wrongEmailOtpJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "email_otp", value: "123456" }),
  });
  assert.equal(correctEmailOtpInput.status, 200, await correctEmailOtpInput.text());
  const manuallyVerifiedJob = await waitForJob(headers, wrongEmailOtpJobId, (value) => value.status === "completed");
  assert.equal(manuallyVerifiedJob.autoRepairEligible, false);
  assert.match(manuallyVerifiedJob.autoRepairEligibilityReason, /手动输入/);

  const phoneFallbackResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "phone@example.com" }),
  });
  const phoneFallbackText = await phoneFallbackResponse.text();
  assert.equal(phoneFallbackResponse.status, 201, phoneFallbackText);
  const phoneFallbackJobId = JSON.parse(phoneFallbackText).job.id;
  await waitForJob(headers, phoneFallbackJobId, (value) => value.status === "phone");
  const firstPhoneInput = await fetch(`${baseUrl}/api/jobs/${phoneFallbackJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60111111111" }),
  });
  assert.equal(firstPhoneInput.status, 200, await firstPhoneInput.text());
  const changePhoneJob = await waitForJob(
    headers,
    phoneFallbackJobId,
    (value) => value.status === "phone" && /更换手机号/.test(value.prompt || ""),
  );
  assert.equal(changePhoneJob.attempt, 1, "a phone-specific fallback error must not restart account login");
  assert.equal(changePhoneJob.restartRequired, false);
  assert.match(changePhoneJob.phoneError || "", /手机号触发了风控/);
  const secondPhoneInput = await fetch(`${baseUrl}/api/jobs/${phoneFallbackJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60122222222" }),
  });
  assert.equal(secondPhoneInput.status, 200, await secondPhoneInput.text());
  await waitForJob(headers, phoneFallbackJobId, (value) => value.status === "phone_otp");
  const phoneOtpInput = await fetch(`${baseUrl}/api/jobs/${phoneFallbackJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone_otp", value: "123456" }),
  });
  assert.equal(phoneOtpInput.status, 200, await phoneOtpInput.text());
  await waitForJob(headers, phoneFallbackJobId, (value) => value.status === "completed");

  const batchReloginResponse = await fetch(`${baseUrl}/api/jobs/relogin-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId, profileJob.id] }),
  });
  const batchReloginText = await batchReloginResponse.text();
  assert.equal(batchReloginResponse.status, 200, batchReloginText);
  const batchRelogin = JSON.parse(batchReloginText);
  assert.equal(batchRelogin.started, 2);
  assert.equal(batchRelogin.skipped, 0);
  await Promise.all([jobId, profileJob.id].map((id) => (
    waitForJob(headers, id, (value) => value.status === "completed" && value.canForceRelogin)
  )));

  const addPasswordResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/add-password`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(addPasswordResponse.status, 200, await addPasswordResponse.text());
  await submitEmailOtp(headers, jobId);
  await submitEmailOtp(headers, jobId);
  const passwordAddedJob = await waitForJob(
    headers,
    jobId,
    (value) => value.status === "completed" && value.passwordAddedAt,
  );
  assert.equal(passwordAddedJob.lastOperationType, "add_password");
  assert.equal(passwordAddedJob.passwordAddError, null);
  assert.equal(passwordAddedJob.canAddPassword, false);

  const passwordSourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId] }),
  });
  const passwordSourceText = await passwordSourceResponse.text();
  assert.equal(passwordSourceResponse.status, 200, passwordSourceText);
  const passwordSourceParts = passwordSourceText.replace(/^\uFEFF/, "").trim().split("----");
  assert.equal(passwordSourceParts[0], "cross-platform@example.com");
  assert.equal(passwordSourceParts[2], "NB2W45DFOIZAQWER");
  assert.equal(passwordSourceParts[1].length, 18);
  assert.match(passwordSourceParts[1], /[a-z]/);
  assert.match(passwordSourceParts[1], /[A-Z]/);
  assert.match(passwordSourceParts[1], /\d/);
  assert.match(passwordSourceParts[1], /[^A-Za-z0-9]/);

  const batchPasswordResponse = await fetch(`${baseUrl}/api/jobs/add-password-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId, profileJob.id] }),
  });
  const batchPasswordText = await batchPasswordResponse.text();
  assert.equal(batchPasswordResponse.status, 200, batchPasswordText);
  const batchPassword = JSON.parse(batchPasswordText);
  assert.equal(batchPassword.started, 1);
  assert.equal(batchPassword.skipped, 1);
  await submitEmailOtp(headers, profileJob.id);
  await submitEmailOtp(headers, profileJob.id);
  const profilePasswordAdded = await waitForJob(
    headers,
    profileJob.id,
    (value) => value.status === "completed" && value.passwordAddedAt,
  );
  assert.equal(profilePasswordAdded.passwordAddError, null);
  assert.equal(profilePasswordAdded.canAddPassword, false);

  const incompleteAuthorizationResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "resume@example.com" }),
  });
  const incompleteAuthorizationText = await incompleteAuthorizationResponse.text();
  assert.equal(incompleteAuthorizationResponse.status, 201, incompleteAuthorizationText);
  const incompleteAuthorizationId = JSON.parse(incompleteAuthorizationText).job.id;
  const loginCompletedJob = await waitForJob(
    headers,
    incompleteAuthorizationId,
    (value) => value.status === "phone" && value.canAddPassword,
  );
  assert.equal(loginCompletedJob.canDownload, false);

  const incompletePasswordResponse = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/add-password`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(incompletePasswordResponse.status, 200, await incompletePasswordResponse.text());
  await submitEmailOtp(headers, incompleteAuthorizationId);
  const incompletePasswordAdded = await waitForJob(
    headers,
    incompleteAuthorizationId,
    (value) => value.status === "resume_available" && value.passwordAddedAt,
  );
  assert.equal(incompletePasswordAdded.canDownload, false);
  assert.equal(incompletePasswordAdded.canRetry, true);
  assert.equal(incompletePasswordAdded.canAddPassword, false);
  assert.equal(incompletePasswordAdded.loginMode, "password");
  assert.match(incompletePasswordAdded.prompt, /可以继续未完成的 Codex 授权/);
  const incompletePasswordLogs = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/logs`, { headers })
    .then((response) => response.json());
  assert.match(incompletePasswordLogs.logs, /Reusing verified login checkpoint/);

  const continueAuthorizationResponse = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/retry`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(continueAuthorizationResponse.status, 200, await continueAuthorizationResponse.text());
  await waitForJob(headers, incompleteAuthorizationId, (value) => value.status === "phone");
  const continuedPhoneResponse = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60123450000" }),
  });
  assert.equal(continuedPhoneResponse.status, 200, await continuedPhoneResponse.text());
  await waitForJob(headers, incompleteAuthorizationId, (value) => value.status === "phone_otp");
  const continuedPhoneOtpResponse = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone_otp", value: "123456" }),
  });
  assert.equal(continuedPhoneOtpResponse.status, 200, await continuedPhoneOtpResponse.text());
  await waitForJob(headers, incompleteAuthorizationId, (value) => value.status === "completed");

  const incompleteTotpResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "resume-phone@example.com" }),
  });
  const incompleteTotpText = await incompleteTotpResponse.text();
  assert.equal(incompleteTotpResponse.status, 201, incompleteTotpText);
  const incompleteTotpId = JSON.parse(incompleteTotpText).job.id;
  const totpLoginCompleted = await waitForJob(
    headers,
    incompleteTotpId,
    (value) => value.status === "phone" && value.canSetupTotp,
  );
  assert.equal(totpLoginCompleted.canDownload, false);

  const incompleteTotpSetupResponse = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/setup-2fa`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(incompleteTotpSetupResponse.status, 200, await incompleteTotpSetupResponse.text());
  const incompleteTotpCompleted = await waitForJob(
    headers,
    incompleteTotpId,
    (value) => value.status === "resume_available" && value.hasTotpKey,
  );
  assert.equal(incompleteTotpCompleted.canDownload, false);
  assert.equal(incompleteTotpCompleted.canRetry, true);
  assert.equal(incompleteTotpCompleted.canSetupTotp, false);
  assert.match(incompleteTotpCompleted.prompt, /2FA 已设置.*继续未完成的 Codex 授权/);
  const incompleteTotpLogs = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/logs`, { headers })
    .then((response) => response.json());
  assert.match(incompleteTotpLogs.logs, /Reusing verified login checkpoint/);

  const continueTotpAuthorizationResponse = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/retry`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(continueTotpAuthorizationResponse.status, 200, await continueTotpAuthorizationResponse.text());
  await waitForJob(headers, incompleteTotpId, (value) => value.status === "phone");
  const continuedTotpPhoneResponse = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60123450001" }),
  });
  assert.equal(continuedTotpPhoneResponse.status, 200, await continuedTotpPhoneResponse.text());
  await waitForJob(headers, incompleteTotpId, (value) => value.status === "phone_otp");
  const continuedTotpPhoneOtpResponse = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone_otp", value: "123456" }),
  });
  assert.equal(continuedTotpPhoneOtpResponse.status, 200, await continuedTotpPhoneOtpResponse.text());
  await waitForJob(headers, incompleteTotpId, (value) => value.status === "completed");

  const cprConfigResponse = await fetch(`${baseUrl}/api/cpr/config`, {
    method: "POST", headers, body: JSON.stringify({ baseUrl: cprUrl, adminApiKey: "test-admin-key", groupIds: ["grp_test"], autoSync: true }),
  });
  assert.equal(cprConfigResponse.status, 200, await cprConfigResponse.text());
  const safeConfig = await (await fetch(`${baseUrl}/api/cpr/config`, { headers })).json();
  assert.equal(safeConfig.hasAdminApiKey, true);
  assert.equal(safeConfig.adminApiKey, undefined);
  const syncResponse = await fetch(`${baseUrl}/api/cpr/sync`, { method: "POST", headers, body: JSON.stringify({ ids: [profileJob.id] }) });
  assert.equal(syncResponse.status, 200);
  const syncResult = await syncResponse.json();
  assert.equal(syncResult.results[0].status, "succeeded");
  assert.equal(importedItems[0].provider, "openai");
  assert.ok(importedItems[0].data.accessToken);
  const syncCount = importedItems.length;
  await fetch(`${baseUrl}/api/cpr/sync`, { method: "POST", headers, body: JSON.stringify({ ids: [profileJob.id] }) });
  assert.equal(importedItems.length, syncCount);

  const mailApiUrl = `${baseUrl}/api/bootstrap`;
  const sourceLines = [
    `password-mail@example.com---test-password----${mailApiUrl}`,
    `password-mail-totp@example.com----test-password-2----${mailApiUrl}----JBSWY3DPEHPK3PXP`,
    `${mailApiUrl}|JBSWY3DPEHPK3PXP|unordered-password|smart.user-name@sub.example.co.uk`,
    `pipe-password@example.dev|part-one|part-two|${mailApiUrl}|NB2W45DFOIZAQWER`,
    `MFRGGZDFMZTWQ2LK::colon-password::name+tag@sub-domain.example.cloud`,
    `${mailApiUrl},reverse.api-order@example.xyz`,
    `manual-totp@example.net--------ONSWG4TFOQXXXXXX======`,
    `user---tag@example.com----hyphen-email-password`,
    `password-empty-field@example.org----plain-password--------GEZDGNBVGY3TQOJQ`,
    `space-group@example.org  grouped-password  JBSW  Y3DP  EHPK  3PXP`,
    `base32-password@example.org----ABCDEFGHIJKLMNOP----${mailApiUrl}`,
    "biers.ellipse.case@icloud.com----aBCD2345eFGH6723----JBSWY3DPEHPK3PXPNB2W45DFOIZAQWER",
    "dot-password@example.com----r7.UjRUWVVS----JBSWY3DPEHPK3PXP",
  ];
  const batchResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: sourceLines.join("\n") }),
  });
  const batchText = await batchResponse.text();
  assert.equal(batchResponse.status, 201, batchText);
  const batch = JSON.parse(batchText);
  assert.equal(batch.jobs.length, 13);
  batch.jobs
    .filter((item) => !["manual-totp@example.net", "reverse.api-order@example.xyz"].includes(item.email))
    .forEach((item) => assert.equal(item.loginMode, "password"));
  batch.jobs
    .filter((item) => [
      "password-mail@example.com",
      "password-mail-totp@example.com",
      "smart.user-name@sub.example.co.uk",
      "pipe-password@example.dev",
      "reverse.api-order@example.xyz",
    ].includes(item.email))
    .forEach((item) => assert.equal(item.autoEmailOtp, true));
  assert.equal(batch.jobs[0].hasTotpKey, false);
  assert.equal(batch.jobs.find((item) => item.email === "password-mail-totp@example.com").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "smart.user-name@sub.example.co.uk").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "pipe-password@example.dev").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "name+tag@sub-domain.example.cloud").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "manual-totp@example.net").loginMode, "email_otp");
  assert.equal(batch.jobs.find((item) => item.email === "user---tag@example.com").loginMode, "password");
  assert.equal(batch.jobs.find((item) => item.email === "password-empty-field@example.org").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "space-group@example.org").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "base32-password@example.org").hasTotpKey, false);
  assert.equal(batch.jobs.find((item) => item.email === "base32-password@example.org").loginMode, "password");
  assert.equal(batch.jobs.find((item) => item.email === "biers.ellipse.case@icloud.com").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "biers.ellipse.case@icloud.com").loginMode, "password");
  assert.equal(batch.jobs.find((item) => item.email === "dot-password@example.com").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "dot-password@example.com").loginMode, "password");
  await Promise.all(batch.jobs.map((item) => waitForJob(headers, item.id, (value) => value.status === "completed")));

  const sourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: batch.jobs.map((item) => item.id) }),
  });
  assert.equal(sourceResponse.status, 200);
  const sourceExport = (await sourceResponse.text()).replace(/^\uFEFF/, "").trim().split("\n").sort();
  assert.deepEqual(sourceExport, [
    `manual-totp@example.net--------ONSWG4TFOQXXXXXX`,
    `name+tag@sub-domain.example.cloud----colon-password----MFRGGZDFMZTWQ2LK`,
    `password-mail-totp@example.com----test-password-2----${mailApiUrl}----JBSWY3DPEHPK3PXP`,
    `password-mail@example.com----test-password----${mailApiUrl}`,
    `pipe-password@example.dev----part-one|part-two----${mailApiUrl}----NB2W45DFOIZAQWER`,
    `reverse.api-order@example.xyz----${mailApiUrl}`,
    `smart.user-name@sub.example.co.uk----unordered-password----${mailApiUrl}----JBSWY3DPEHPK3PXP`,
    `space-group@example.org----grouped-password----JBSWY3DPEHPK3PXP`,
    `password-empty-field@example.org----plain-password----GEZDGNBVGY3TQOJQ`,
    `user---tag@example.com----hyphen-email-password`,
    `base32-password@example.org----ABCDEFGHIJKLMNOP----${mailApiUrl}`,
    "biers.ellipse.case@icloud.com----aBCD2345eFGH6723----JBSWY3DPEHPK3PXPNB2W45DFOIZAQWER",
    "dot-password@example.com----r7.UjRUWVVS----JBSWY3DPEHPK3PXP",
  ].sort());

  const ambiguousBatchLines = [
    `two-emails@example.com----second@example.net----${mailApiUrl}`,
    `comma-url@example.com,${mailApiUrl}?a=1,b=2`,
    "odd-hyphen@example.com-----JBSWY3DPEHPK3PXP",
    `mixed-delimiter@example.com----password|${mailApiUrl}|JBSWY3DPEHPK3PXP`,
  ];
  for (const text of ambiguousBatchLines) {
    const response = await fetch(`${baseUrl}/api/jobs/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 400, `${text}: ${responseText}`);
  }

  const preserveCredentialsResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "password-mail-totp@example.com" }),
  });
  assert.equal(preserveCredentialsResponse.status, 201, await preserveCredentialsResponse.text());
  const preservedSourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [batch.jobs[1].id] }),
  });
  assert.equal(preservedSourceResponse.status, 200);
  assert.match(
    (await preservedSourceResponse.text()).replace(/^\uFEFF/, ""),
    new RegExp(`password-mail-totp@example\\.com----test-password-2----.*----JBSWY3DPEHPK3PXP`),
  );

  const manualPhoneResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "manual-phone-automation@example.com", password: "saved-phone-password" }),
  });
  const manualPhoneText = await manualPhoneResponse.text();
  assert.equal(manualPhoneResponse.status, 201, manualPhoneText);
  const manualPhoneJobId = JSON.parse(manualPhoneText).job.id;
  await waitForJob(headers, manualPhoneJobId, (value) => value.status === "phone");
  const manualPhoneInput = await fetch(`${baseUrl}/api/jobs/${manualPhoneJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60123456789" }),
  });
  assert.equal(manualPhoneInput.status, 200, await manualPhoneInput.text());
  await waitForJob(headers, manualPhoneJobId, (value) => value.status === "phone_otp");
  const manualPhoneOtpInput = await fetch(`${baseUrl}/api/jobs/${manualPhoneJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone_otp", value: "123456" }),
  });
  assert.equal(manualPhoneOtpInput.status, 200, await manualPhoneOtpInput.text());
  const manualPhoneCompleted = await waitForJob(
    headers,
    manualPhoneJobId,
    (value) => value.status === "completed",
  );
  assert.equal(manualPhoneCompleted.autoRepairEligible, true);

  const autoSynced = await waitForJob(headers, batch.jobs.find(item => item.email === "password-mail@example.com").id, value => value.cprSync?.status === "succeeded");
  assert.deepEqual(autoSynced.cprSync.accountIds, ["acct_test"]);

  const directRiskResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "direct-risk-retry@example.com" }),
  });
  assert.equal(directRiskResponse.status, 201);
  const directRiskCreated = await directRiskResponse.json();
  const directRiskFailed = await waitForJob(
    headers,
    directRiskCreated.job.id,
    (value) => value.status === "failed",
  );
  assert.match(directRiskFailed.lastError || "", /直连 TLS 指纹筛选已经使用过/);
  const directRiskReloginResponse = await fetch(`${baseUrl}/api/jobs/${directRiskCreated.job.id}/relogin`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(directRiskReloginResponse.status, 200, await directRiskReloginResponse.text());
  await waitForJob(headers, directRiskCreated.job.id, (value) => value.status === "completed");

  const rotatingProxy = "socks5h://account-region-JP-sid-initial-t-20:password@proxy.example:5000";
  const proxyRetryResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "proxy-risk-retry@example.com", proxyUrl: rotatingProxy }),
  });
  assert.equal(proxyRetryResponse.status, 201);
  const proxyRetryCreated = await proxyRetryResponse.json();
  const proxyRetryCompleted = await waitForJob(
    headers,
    proxyRetryCreated.job.id,
    (value) => value.status === "completed",
  );
  assert.equal(proxyRetryCompleted.canDownload, true);
  const proxyRetryLogs = await fetch(`${baseUrl}/api/jobs/${proxyRetryCreated.job.id}/logs`, { headers }).then((response) => response.json());
  assert.match(proxyRetryLogs.logs, /正在检测第 1\/10 个新代理会话/);
  assert.match(proxyRetryLogs.logs, /正在检测第 3\/10 个新代理会话/);

  const proxyAlwaysResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "proxy-risk-always@example.com", proxyUrl: rotatingProxy }),
  });
  assert.equal(proxyAlwaysResponse.status, 201);
  const proxyAlwaysCreated = await proxyAlwaysResponse.json();
  const proxyAlwaysFailed = await waitForJob(
    headers,
    proxyAlwaysCreated.job.id,
    (value) => value.status === "failed",
  );
  assert.match(proxyAlwaysFailed.lastError || "", /自动更换 10 次/);
  const proxyAlwaysLogs = await fetch(`${baseUrl}/api/jobs/${proxyAlwaysCreated.job.id}/logs`, { headers }).then((response) => response.json());
  assert.equal((proxyAlwaysLogs.logs.match(/个新代理会话/g) || []).length, 10);
  assert.doesNotMatch(proxyAlwaysLogs.logs, /正在检测第 11\//);

  const proxyConnectionResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "proxy-connection-retry@example.com", proxyUrl: rotatingProxy }),
  });
  assert.equal(proxyConnectionResponse.status, 201);
  const proxyConnectionCreated = await proxyConnectionResponse.json();
  await waitForJob(headers, proxyConnectionCreated.job.id, (value) => value.status === "completed");
  const proxyConnectionLogs = await fetch(`${baseUrl}/api/jobs/${proxyConnectionCreated.job.id}/logs`, { headers })
    .then((response) => response.json());
  assert.match(proxyConnectionLogs.logs, /HTTP 检测次数仍为 0\/10；连接失败 1\/20/);
  assert.equal((proxyConnectionLogs.logs.match(/个新代理会话/g) || []).length, 1);

  const proxyConnectionAlwaysResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "proxy-connection-always@example.com", proxyUrl: rotatingProxy }),
  });
  assert.equal(proxyConnectionAlwaysResponse.status, 201);
  const proxyConnectionAlwaysCreated = await proxyConnectionAlwaysResponse.json();
  const proxyConnectionAlwaysFailed = await waitForJob(
    headers,
    proxyConnectionAlwaysCreated.job.id,
    (value) => value.status === "failed",
  );
  assert.match(proxyConnectionAlwaysFailed.lastError || "", /连续失败 20 次/);

  const deleteResponse = await fetch(`${baseUrl}/api/jobs/delete-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [
      jobId,
      profileJob.id,
      mfaPromptJobId,
      wrongEmailOtpJobId,
      ...batch.jobs.map((item) => item.id),
      proxyRetryCreated.job.id,
      proxyAlwaysCreated.job.id,
      proxyConnectionCreated.job.id,
      proxyConnectionAlwaysCreated.job.id,
      directRiskCreated.job.id,
      manualPhoneJobId,
      phoneFallbackJobId,
      incompleteAuthorizationId,
      incompleteTotpId,
    ] }),
  });
  if (!deleteResponse.ok) {
    throw new Error(`delete request failed with HTTP ${deleteResponse.status}: ${await deleteResponse.text()}`);
  }
  const deleted = await deleteResponse.json();
  assert.equal(deleted.deleted, 26);

  const finalPage = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  assert.equal(finalPage.pagination.total, 0);
  console.log("console smoke tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  if (isRunning(child)) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await new Promise((resolve) => cpr.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function verifySourceExport(headers, account, expectedStatus) {
  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST", headers, body: JSON.stringify(account),
  });
  assert.equal(created.status, 201);
  const { job } = await created.json();
  await waitForJob(headers, job.id, value => value.status === "completed");
  const exported = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST", headers, body: JSON.stringify({ ids: [job.id] }),
  });
  const text = await exported.text();
  assert.equal(exported.status, expectedStatus, account.email);
  if (expectedStatus === 200) {
    const imported = await fetch(`${baseUrl}/api/jobs/batch`, {
      method: "POST", headers, body: JSON.stringify({ text }),
    });
    assert.equal(imported.status, 201, account.email);
    const result = await imported.json();
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].email, account.email);
    assert.equal(result.jobs[0].autoEmailOtp, Boolean(account.mailApiUrl || account.mailRequestBody));
  } else {
    assert.equal(exported.headers.get("content-disposition"), null);
    assert.match(JSON.parse(text).error, /无法无损导出/);
    for (const value of [account.password, account.totpSecret, account.mailApiUrl, account.mailRequestBody].filter(Boolean)) {
      assert.ok(!text.includes(value), "错误响应不能包含凭据内容");
    }
  }
  const stored = await sourceCredentials.load(account.email);
  assert.equal(stored.password, account.password || "");
  assert.equal(stored.totpSecret, account.totpSecret || "");
  const deleted = await fetch(`${baseUrl}/api/jobs/delete-batch`, {
    method: "POST", headers, body: JSON.stringify({ ids: [job.id] }),
  });
  assert.equal(deleted.status, 200);
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
    assert.equal(response.status, 200);
    const page = await response.json();
    const job = page.jobs.find((item) => item.id === jobId);
    if (job && predicate(job)) return job;
    await delay(100);
  }
  throw new Error(`job ${jobId} did not reach the expected state`);
}

async function submitEmailOtp(headers, jobId) {
  await waitForJob(headers, jobId, (value) => value.status === "email_otp");
  const response = await fetch(`${baseUrl}/api/jobs/${jobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "email_otp", value: "123456" }),
  });
  assert.equal(response.status, 200, await response.text());
  await waitForJob(headers, jobId, (value) => value.status !== "working");
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
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(processHandle) {
  return processHandle.exitCode === null && processHandle.signalCode === null;
}
