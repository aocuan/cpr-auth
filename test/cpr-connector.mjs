// 使用受控 CPR HTTP 服务验证真实请求、恢复、去重与敏感数据边界
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCprConnector } from '../src/cpr-connector.mjs';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpr-connector-'));
const calls = [];
let mode = 'success';
let completed = true;
const server = http.createServer(async (req, res) => {
  assert.equal(req.headers['x-api-key'], 'fixture-admin-key');
  const url = new URL(req.url, 'http://localhost');
  const reply = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: status === 202 ? 200 : status, data })); };
  if (url.pathname.includes('account-groups')) return reply({ items: [{ id: 'grp_test', name: 'Test', enabled: true }] });
  if (url.pathname === '/api/admin/proxies') return reply({ items: [{ id: 'proxy_test', name: 'Proxy', enabled: true }] });
  if (url.pathname === '/api/admin/accounts/detail') return reply({ account: { id: url.searchParams.get('accountId'), provider: 'openai', email: url.searchParams.get('accountId') === 'wrong' ? 'other@example.com' : 'fixture@example.com' } });
  if (url.pathname === '/api/admin/accounts/import-tasks' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw));
    if (mode === 'disconnect') return req.socket.destroy();
    if (mode === 'reject') return reply(null, 401);
    return reply({ taskId: `task_${calls.length}` }, 202);
  }
  if (url.pathname === '/api/admin/accounts/import-tasks/detail') {
    if (mode === 'expired') return reply(null, 404);
    return reply({ total: 1, finishedAt: completed ? new Date().toISOString() : null, items: [{ status: mode === 'failure' ? 'failed' : 'succeeded', accountIds: mode === 'failure' ? [] : ['acct_fixture'] }] });
  }
  reply(null, 404);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const config = { baseUrl, adminApiKey: 'fixture-admin-key', groupIds: ['grp_test'], outboundProxyId: 'proxy_test', autoSync: true };
const job = { id: 'job1', email: 'fixture@example.com', status: 'completed', resultSaved: true, outputPath: path.join(root, 'output.json') };
await fs.writeFile(job.outputPath, JSON.stringify({ accounts: [{ credentials: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id', model_mapping: { ignored: 'ignored' } }, proxy_key: 'ignored' }] }));
let connector;
try {
  connector = await createCprConnector(root);
  assert.equal(connector.publicConfig().configured, false);
  await connector.save(config);
  assert.equal(connector.publicConfig().adminApiKey, undefined);
  assert.equal((await fs.readFile(path.join(root, 'cpr-state.enc'))).includes(Buffer.from('fixture-admin-key')), false);
  const results = await Promise.all([connector.sync(job), connector.sync(job)]);
  assert.equal(calls.length, 1);
  assert.equal(results[0].status, 'succeeded');
  assert.deepEqual(calls[0].items[0], { provider: 'openai', data: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id' }, outboundProxyId: 'proxy_test', settings: { enabled: true, concurrencyLimit: null, weight: 1, groupIds: ['grp_test'] } });
  assert.equal(JSON.stringify(results).includes('fixture-admin-key'), false);
  await connector.close();
  connector = await createCprConnector(root);
  await connector.sync(job); assert.equal(calls.length, 1);
  // 远端接受但未完成，重启后只继续查询
  completed = false;
  await connector.sync({ ...job, id: 'pending' }); assert.equal(calls.length, 2);
  await connector.close(); connector = await createCprConnector(root);
  completed = true; await connector.poll(); assert.equal(connector.view('pending').status, 'succeeded'); assert.equal(calls.length, 2);
  // 提交时断线不能盲重试，包括重启以后
  mode = 'disconnect';
  assert.equal((await connector.sync({ ...job, id: 'lost' })).status, 'unknown');
  await connector.close(); connector = await createCprConnector(root);
  await connector.sync({ ...job, id: 'lost' }); assert.equal(calls.length, 3);
  mode = 'success';
  await assert.rejects(connector.reconcile('lost', 'wrong'), /邮箱/);
  await connector.reconcile('lost', 'acct_fixture'); assert.equal(connector.view('lost').status, 'succeeded');
  mode = 'reject';
  assert.equal((await connector.sync({ ...job, id: 'rejected' })).status, 'failed');
  mode = 'success';
  assert.equal((await connector.sync({ ...job, id: 'rejected' })).status, 'succeeded');
  assert.equal(calls.length, 5);
  completed = false;
  await connector.sync({ ...job, id: 'expired' }); mode = 'expired'; await connector.poll();
  assert.equal(connector.view('expired').status, 'unknown');
  await connector.sync({ ...job, id: 'expired' }); assert.equal(calls.length, 6);
  mode = 'success'; completed = true;
  await connector.confirmNotImported('expired');
  assert.equal(connector.view('expired').status, 'succeeded', '远端恢复且已成功时不能解锁重试');
  mode = 'disconnect'; await connector.sync({ ...job, id: 'absent' });
  await connector.confirmNotImported('absent');
  assert.equal(connector.view('absent').status, 'failed');
  mode = 'success'; await connector.sync({ ...job, id: 'absent' });
  assert.equal(connector.view('absent').status, 'succeeded');
  await assert.rejects(connector.save({ ...config, baseUrl: 'http://user:secret@example.com' }), /HTTP/);
  await assert.rejects(connector.save({ ...config, baseUrl: 'http://another.example', adminApiKey: '' }), /Key/);
  await assert.rejects(connector.sync({ ...job, status: 'running' }), /已完成/);
  console.log('CPR connector: HTTP contract, encryption, concurrent dedup, restart recovery, ambiguous results and safe retry passed');
} finally {
  await connector?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
}
