// 参考 Cengyj/toSub2 的移除、激活和保存确认流程；恢复只执行未发起的修改
import { createFileCredentialStore } from "./file-credential-store.mjs";

export const ROTATION_TERMINAL = new Set(["committed", "unchanged", "reconciled"]);
export function createRotationStore(root) {
  const files = createFileCredentialStore(root);
  return {
    async load(email) {
      const raw = await files.load(email);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (state.version !== 1 || state.email !== email.toLowerCase() || !state.operationId || !state.phase) {
        throw new Error("2FA 恢复记录无效，请恢复完整备份");
      }
      return state;
    },
    async save(state) { await files.save(state.email, JSON.stringify(state)); },
  };
}

export function rotationView(state) {
  if (!state) return null;
  return { phase: state.phase, error: state.error || null, recoveryRequired: !ROTATION_TERMINAL.has(state.phase) };
}

// request 必须是禁止重放的账号安全请求；ack 在新密钥安全保存并读回后才返回
export async function rotateTotp({ state, save, request, generateCode, acknowledge, recover = false }) {
  const persist = async (phase, fields = {}) => {
    Object.assign(state, fields, { phase, error: null, updatedAt: new Date().toISOString() });
    await save(state);
  };
  const info = () => request("GET", "mfa_info");
  const factors = data => {
    if (!Array.isArray(data?.factors?.totp) || data.factors.totp.some(f =>
      !f || f.factor_type !== "totp" || f.is_recovery !== false || typeof f.id !== "string" || !f.id)) {
      throw new Error("验证器信息不明确，请在账号安全设置中核实");
    }
    return data.factors.totp;
  };
  const verified = data => (data.mfa_enabled === true || data.mfa_enabled_v2 === true)
    && factors(data).length === 1 && factors(data)[0].id === state.newFactorId;
  try {
    if (ROTATION_TERMINAL.has(state.phase)) return state;
    let current = await info();
    const currentFactors = factors(current);
    if (recover) {
      if (state.newFactorId && verified(current)) {
        await persist("verified", { activationAccepted: true });
      } else if (state.phase === "disable_intent" && currentFactors.length === 1 && currentFactors[0].id === state.oldFactorId) {
        // 只解除当前操作；再次移除仍需用户重新确认新的操作
        await persist("unchanged");
        return state;
      } else if (state.phase === "disable_intent" && currentFactors.length === 0) {
        await persist("disabled");
      } else if (["enroll_intent", "activation_intent", "verified"].includes(state.phase)) {
        throw new Error("远端修改结果仍不明确，已保留恢复材料；请在账号安全设置中核实，不会重复提交");
      }
    } else if (state.phase !== "pending") {
      throw new Error("已有未完成的更换，请先核对恢复");
    }
    if (state.phase === "pending") {
      if (recover) {
        await persist("unchanged");
        return state;
      }
      if (!(current.mfa_enabled === true || current.mfa_enabled_v2 === true) || currentFactors.length !== 1) {
        throw new Error("仅支持更换一个已启用的普通 2FA 验证器");
      }
      await acknowledge("preflight");
      await persist("disable_intent", { oldFactorId: currentFactors[0].id });
      const disabled = await request("POST", "mfa/user/disable_in_house", { factor_id: state.oldFactorId });
      if (disabled?.message !== "Factor disabled") throw new Error("旧验证器移除结果未确认，请核对恢复");
      current = await info();
      if (factors(current).length !== 0) throw new Error("旧验证器仍存在，请核对恢复");
      await persist("disabled");
    }
    if (state.phase === "disabled") {
      if (factors(await info()).length) throw new Error("远端验证器已发生变化，请人工核对");
      await persist("enroll_intent");
      const enrollment = await request("POST", "mfa/enroll", { factor_type: "totp", source: "settings" });
      const secret = String(enrollment?.secret || "").toUpperCase().replace(/[\s=]/g, "");
      if (!/^[A-Z2-7]{16,128}$/.test(secret) || !enrollment.session_id || !enrollment.factor?.id
        || enrollment.factor.id === state.oldFactorId || enrollment.factor.factor_type !== "totp" || enrollment.factor.is_recovery !== false) {
        throw new Error("新验证器信息不完整，已停止激活，请人工核对");
      }
      await persist("enrolled", { secret, enrollmentId: enrollment.session_id, newFactorId: enrollment.factor.id });
    }
    if (state.phase === "enrolled") {
      // 激活前密钥已加密并同步到磁盘，超时后只查询，不重发激活
      await persist("activation_intent");
      const activation = await request("POST", "mfa/user/activate_enrollment", {
        factor_type: "totp", session_id: state.enrollmentId, code: generateCode(state.secret), source: "settings",
      });
      if (activation?.success !== true) throw new Error("新验证器激活未确认，请核对恢复");
      await persist("activation_intent", { activationAccepted: true });
      if (!verified(await info())) throw new Error("新验证器尚未核实，密钥已保留，请核对恢复");
      await persist("verified");
    }
    if (state.phase === "verified") {
      await acknowledge("credential");
      // 凭据存储是完成后的唯一密钥来源，清除恢复会话与临时密钥
      await persist("committed", { secret: undefined, cookies: undefined, enrollmentId: undefined });
    }
    return state;
  } catch (error) {
    state.error = error.message;
    await save(state).catch(() => {});
    throw error;
  }
}

export function parentAcknowledgement(operationId, stage) {
  if (!process.connected || !operationId) return Promise.reject(new Error("缺少安全保存确认通道"));
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      process.off("message", receive);
      process.off("disconnect", disconnected);
      error ? reject(error) : resolve();
    };
    const disconnected = () => finish(new Error("安全保存通道中断，恢复材料已保留"));
    const receive = message => {
      if (message?.type === "rotation-ack" && message.operationId === operationId && message.stage === stage) {
        finish(message.ok ? null : new Error("安全凭据保存未确认，请核对恢复"));
      }
    };
    const timer = setTimeout(() => finish(new Error("安全保存确认超时，请核对恢复")), 15_000);
    process.on("message", receive);
    process.once("disconnect", disconnected);
    process.send({ type: "rotation-ready", operationId, stage }, error => { if (error) disconnected(); });
  });
}
