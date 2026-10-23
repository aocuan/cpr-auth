// 更换流程的中断、歧义、保存失败和恢复不变量，所有账号均为合成数据
import assert from "node:assert/strict";
import { rotateTotp } from "../src/totp-rotation.mjs";
const secret = "JBSWY3DPEHPK3PXP";
const factor = id => ({ id, factor_type: "totp", is_recovery: false });
for (const fault of [null, "preflight", "disable-before", "disable-after", "enroll-before", "enroll-after", "activation-before", "activation-after", "verification", "credential", "save-enrolled", "save-committed"]) {
  let state = { version: 1, email: "fixture@example.com", operationId: "fixture", phase: "pending" };
  let durable = structuredClone(state), factors = [factor("old")], key = "old", faulted = false;
  const count = { disable: 0, enroll: 0, activate: 0 };
  const fail = name => { if (fault === name && !faulted) { faulted = true; throw new Error(`synthetic ${name}`); } };
  const run = recover => rotateTotp({ state, recover, generateCode: () => "123456",
    save: async value => { fail(`save-${value.phase}`); durable = structuredClone(value); },
    acknowledge: async stage => { fail(stage); if (stage === "credential") { assert.equal(factors[0].id, "new"); key = state.secret; } },
    request: async (method, endpoint) => {
      if (method === "GET") { if (count.activate) fail("verification"); return { mfa_enabled: factors.length > 0, factors: { totp: factors } }; }
      if (endpoint.endsWith("disable_in_house")) { count.disable++; fail("disable-before"); factors = []; fail("disable-after"); return { message: "Factor disabled" }; }
      if (endpoint.endsWith("enroll")) { count.enroll++; fail("enroll-before"); fail("enroll-after"); return { secret, session_id: "enrollment", factor: factor("new") }; }
      if (endpoint.endsWith("activate_enrollment")) { count.activate++; fail("activation-before"); factors = [factor("new")]; fail("activation-after"); return { success: true }; }
      throw new Error("unexpected endpoint");
    },
  });
  try { await run(false); } catch { assert.ok(fault); }
  state = structuredClone(durable);
  if (state.phase !== "committed") { try { await run(true); } catch {} }
  assert.ok(count.disable <= 1 && count.enroll <= 1 && count.activate <= 1, `${fault}: mutation replayed`);
  if ([null, "disable-after", "activation-after", "verification", "credential", "save-enrolled", "save-committed"].includes(fault)) {
    assert.equal(state.phase, "committed", fault); assert.equal(key, secret, fault);
  }
  if (state.phase === "committed") assert.equal(state.secret, undefined);
  console.log(`rotation fault recovery: ${fault || "success"}`);
}
// 歧义因子和错误账号状态不得发送移除请求
for (const factors of [[factor("a"), factor("b")], [{ ...factor("a"), is_recovery: true }], []]) {
  let posts = 0;
  await assert.rejects(rotateTotp({ state: { phase: "pending" }, save: async () => {}, acknowledge: async () => {},
    request: async method => { if (method === "POST") posts++; return { mfa_enabled: true, factors: { totp: factors } }; }, generateCode: () => "123456" }));
  assert.equal(posts, 0);
}
console.log("TOTP rotation state and recovery tests passed");
