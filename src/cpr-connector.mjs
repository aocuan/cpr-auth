// CPR 管理连接、加密配置和可恢复的导入状态；不承担授权流程
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const fail = (status, message) => Object.assign(new Error(message), { status });
export async function createCprConnector(root, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const keyPath = path.join(root, 'cpr-key');
  let key;
  try { key = await fs.readFile(keyPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = crypto.randomBytes(32);
    await fs.writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
  }
  if (key.length !== 32) throw new Error('CPR 加密密钥无效');
  const statePath = path.join(root, 'cpr-state.enc');
  let state = { config: null, records: {} };
  try {
    const raw = await fs.readFile(statePath);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    state = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法解密 CPR 配置，请恢复配套密钥与数据'); }
  let writing = Promise.resolve();
  const persist = () => {
    const plain = JSON.stringify(state);
    writing = writing.catch(() => {}).then(async () => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([cipher.update(plain), cipher.final()]);
      const temp = `${statePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, Buffer.concat([iv, cipher.getAuthTag(), content]), { mode: 0o600 });
      await fs.rename(temp, statePath);
    });
    return writing;
  };
  // 提交前已经落盘但未获得 taskId 时，重启不能证明远端是否已接收
  for (const record of Object.values(state.records)) {
    if (record.status === 'submitting') record.status = 'unknown';
  }
  await persist();
  const active = new Map();
  const controllers = new Set();
  let closing = false;
  const publicConfig = () => {
    const { adminApiKey, ...config } = state.config || {};
    return { ...config, configured: Boolean(adminApiKey), hasAdminApiKey: Boolean(adminApiKey) };
  };
  const view = (id) => {
    const record = state.records[id];
    if (!record) return null;
    const { connection, ...safe } = record;
    return safe;
  };
  function normalize(input) {
    let url;
    try { url = new URL(String(input.baseUrl || '').trim()); } catch { throw fail(400, '请输入 CPR 服务地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail(400, 'CPR 地址必须为无认证信息的 HTTP(S) 地址');
    const baseUrl = url.href.replace(/\/+$/, '');
    const adminApiKey = String(input.adminApiKey || '').trim() || (state.config?.baseUrl === baseUrl ? state.config.adminApiKey : '');
    if (!adminApiKey || /[\r\n]/.test(adminApiKey)) throw fail(400, '请输入管理员 API Key；更换地址需要重新输入');
    const groupIds = Array.isArray(input.groupIds) ? [...new Set(input.groupIds.map(String))] : [];
    if (groupIds.length > 100 || groupIds.some(id => !id || id.length > 200)) throw fail(400, '分组配置无效');
    return { baseUrl, adminApiKey, groupIds, outboundProxyId: String(input.outboundProxyId || ''), autoSync: input.autoSync === true };
  }
  async function request(config, route, body) {
    if (closing) throw fail(503, "服务正在关闭");
    const controller = new AbortController();
    controllers.add(controller);
    try {
      let response;
      try {
        response = await fetchImpl(`${config.baseUrl}${route}`, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
          headers: { 'x-api-key': config.adminApiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch { throw fail(502, '无法连接 CPR 或请求超时'); }
      if (!response.ok) { await response.body?.cancel(); throw fail(response.status, `CPR 返回 HTTP ${response.status}`); }
      let payload;
      try { payload = await response.json(); } catch { throw fail(502, 'CPR 返回了无效响应'); }
      if (payload.code !== 200 || payload.data == null) throw fail(502, 'CPR 响应不符合管理 API 合同');
      return payload.data;
    } finally { controllers.delete(controller); }
  }

  async function options(input) {
    const config = input ? normalize(input) : state.config;
    if (!config) throw fail(400, '请先配置 CPR');
    async function pages(route) {
      const items = [];
      for (let page = 1; page <= 100; page++) {
        const result = await request(config, `${route}?page=${page}&pageSize=100`);
        if (!Array.isArray(result.items)) throw fail(502, 'CPR 列表响应不符合合同');
        items.push(...result.items);
        if (result.items.length < 100) return items;
      }
      throw fail(400, '配置项过多，请缩小 CPR 配置规模');
    }
    const [groups, proxies] = await Promise.all([pages('/api/admin/account-groups/options'), pages('/api/admin/proxies')]);
    return { groups: groups.map(({ id, name, enabled }) => ({ id, name, enabled })), proxies: proxies.map(({ id, name, enabled }) => ({ id, name, enabled })) };
  }
  async function save(input) {
    const config = normalize(input);
    const available = await options(config);
    if (config.groupIds.some(id => !available.groups.some(g => g.id === id && g.enabled))) throw fail(400, '所选分组不存在或已停用');
    if (config.outboundProxyId && !available.proxies.some(p => p.id === config.outboundProxyId && p.enabled)) throw fail(400, '所选代理不存在或已停用');
    state.config = config;
    await persist();
    return publicConfig();
  }
  const currentConnection = record => state.config?.baseUrl === record.baseUrl ? state.config : record.connection;
  async function refresh(id) {
    const record = state.records[id];
    if (!record?.taskId || !['submitted', 'unknown'].includes(record.status)) return view(id);
    try {
      const detail = await request(currentConnection(record), `/api/admin/accounts/import-tasks/detail?taskId=${encodeURIComponent(record.taskId)}`);
      if (!detail.finishedAt) {
        record.status = 'submitted'; record.message = 'CPR 正在导入'; await persist(); return view(id);
      }
      const item = detail.items?.[0];
      if (!item || detail.total !== 1) throw fail(502, '导入任务结果不符合合同');
      record.accountIds = Array.isArray(item.accountIds) ? item.accountIds : [];
      record.status = item.status === 'succeeded' && record.accountIds.length ? 'succeeded' : ['failed', 'skipped'].includes(item.status) ? 'failed' : 'unknown';
      record.message = record.status === 'succeeded' ? '已同步到 CPR' : record.status === 'failed' ? 'CPR 导入失败，可检查配置后重试同步' : '导入结果未知，请先到 CPR 核对账号';
      record.updatedAt = new Date().toISOString();
      // 已完成的记录不继续保留历史管理员密钥
      if (record.status !== 'unknown') delete record.connection;
      await persist();
    } catch (error) {
      record.message = error.status === 404 ? 'CPR 任务已过期或重启丢失，请核对账号后处理' : '暂时无法查询 CPR，稍后继续核对';
      if (error.status === 404) record.status = 'unknown';
      await persist();
    }
    return view(id);
  }
  function locked(id, action) {
    const previous = active.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(action).finally(() => {
      if (active.get(id) === operation) active.delete(id);
    });
    active.set(id, operation);
    return operation;
  }
  function sync(job) { return locked(job.id, () => perform(job)); }
  async function perform(job) {
    if (closing) throw fail(503, "服务正在关闭");
    if (!state.config) throw fail(400, '请先配置 CPR');
    if (!job.resultSaved || job.deleted || job.status !== 'completed') throw fail(409, '只有已完成的授权任务可以同步');
    const raw = await fs.readFile(job.outputPath, 'utf8');
    const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
    const previous = state.records[job.id];
    if (previous && ['submitting', 'submitted', 'unknown'].includes(previous.status)) return refresh(job.id);
    if (previous?.status === 'succeeded' && previous.fingerprint === fingerprint && previous.baseUrl === state.config.baseUrl) return view(job.id);
    let document;
    try { document = JSON.parse(raw); } catch { throw fail(400, '授权文件格式无效'); }
    const account = document.accounts?.[0];
    if (document.accounts?.length !== 1 || !account?.credentials) throw fail(400, '每个授权任务必须对应一个 OAuth 账号');
    const credentials = account.credentials;
    const accessToken = credentials.access_token || credentials.accessToken;
    const refreshToken = credentials.refresh_token || credentials.refreshToken;
    const idToken = credentials.id_token || credentials.idToken;
    if (!accessToken && !refreshToken) throw fail(400, '授权文件缺少 OAuth token');
    // 只传 CPR 已支持的凭据字段；不透传原工具的平台参数或代理引用
    const config = { ...state.config };
    const item = { provider: 'openai', data: { accessToken, refreshToken, idToken } };
    if (config.outboundProxyId) item.outboundProxyId = config.outboundProxyId;
    if (config.groupIds.length) item.settings = { enabled: true, concurrencyLimit: null, weight: 1, groupIds: config.groupIds };
    const record = { email: String(credentials.email || job.email || '').toLowerCase(), status: 'submitting', submissionId: crypto.randomUUID(), fingerprint, baseUrl: config.baseUrl, connection: config, taskId: null, accountIds: [], updatedAt: new Date().toISOString(), message: '正在提交 CPR' };
    state.records[job.id] = record;
    await persist();
    try {
      const result = await request(config, '/api/admin/accounts/import-tasks', { submissionId: record.submissionId, items: [item] });
      if (typeof result.taskId !== 'string' || !result.taskId) throw fail(502, 'CPR 未返回任务标识');
      record.taskId = result.taskId;
      record.status = 'submitted';
      record.message = 'CPR 正在导入';
    } catch (error) {
      // 明确拒绝可以重试；网络、5xx 和无法解析的响应都不能证明未提交
      record.status = [400, 401, 403, 404, 413, 422, 429].includes(error.status) ? 'failed' : 'unknown';
      record.message = record.status === 'failed' ? error.message : '提交结果未知，请先到 CPR 核对，系统不会重复提交';
      if (record.status === 'failed') delete record.connection;
    }
    await persist();
    return refresh(job.id);
  }
  // 人工核对后只允许明确认领已存在的账号，不能把未知提交自动当作失败重做
  async function reconcile(id, accountId) {
    const record = state.records[id];
    if (!record || record.status !== 'unknown') throw fail(409, '当前任务无需人工核对');
    const detail = await request(currentConnection(record), `/api/admin/accounts/detail?accountId=${encodeURIComponent(accountId)}`);
    if (detail.account?.id !== accountId || detail.account?.provider !== 'openai') throw fail(400, '目标不是有效的 CPR OpenAI 账号');
    if (!record.email || String(detail.account.email || '').toLowerCase() !== record.email) throw fail(400, '目标账号邮箱与授权任务不一致，不能关联');
    record.status = 'succeeded'; record.accountIds = [accountId]; record.message = '已由管理员核对并关联 CPR 账号'; record.updatedAt = new Date().toISOString();
    delete record.connection;
    await persist();
    return view(id);
  }
  async function confirmNotImported(id) {
    const record = state.records[id];
    if (!record || record.status !== 'unknown') throw fail(409, '当前任务无需人工核对');
    if (record.taskId) await refresh(id);
    if (record.status !== 'unknown') return view(id);
    record.status = 'failed'; record.message = '管理员已确认未入库，可以重试同步';
    record.updatedAt = new Date().toISOString(); delete record.connection;
    await persist(); return view(id);
  }
  return { confirmNotImported: id => locked(id, () => confirmNotImported(id)), publicConfig, view, save, options, sync, refresh: id => locked(id, () => refresh(id)), reconcile: (id, accountId) => locked(id, () => reconcile(id, accountId)), autoSync: () => state.config?.autoSync === true,
    async poll() { for (const [id, record] of Object.entries(state.records)) if (record.taskId && record.status === 'submitted' && !active.has(id)) await locked(id, () => refresh(id)); },
    async close() { closing = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...active.values()]); await writing; },
  };
}
