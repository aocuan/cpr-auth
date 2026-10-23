// 验证生产访问控制、静态资源边界和健康检查
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpr-access-'));
const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const child = spawn(process.execPath, ['src/console-server.mjs', '--port', String(port)], { env: { ...process.env, NODE_ENV: 'production', ONBOARDING_OUTPUT_ROOT: root, CPR_AUTH_PASSWORD: 'fixture-password-only' }, stdio: 'pipe' });
const exited = new Promise(resolve => child.once('exit', resolve));
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Basic ${Buffer.from('admin:fixture-password-only').toString('base64')}` };
try {
 for (let i=0;i<100;i++) { try { if ((await fetch(`${base}/healthz`)).status === 204) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
 for (const route of ['/', '/api/bootstrap', '/api/cpr/config']) assert.equal((await fetch(base+route)).status, 401);
 assert.equal((await fetch(base, {headers})).status, 200);
 assert.equal((await fetch(`${base}/src/main.jsx`, {headers})).status, 404);
 assert.equal((await fetch(`${base}/@fs/etc/passwd`, {headers})).status, 404);
 assert.equal((await fetch(`${base}/api/cpr/config`, {headers})).status, 403);
 const {token} = await (await fetch(`${base}/api/bootstrap`, {headers})).json();
 const result = await fetch(`${base}/api/cpr/config`, {headers:{...headers,'x-console-token':token}});
 assert.equal(result.status, 200); assert.equal((await result.json()).configured, false);
 console.log('CPR production access: login, API token, health check and static boundary passed');
} finally { child.kill('SIGTERM'); await exited; await fs.rm(root,{recursive:true,force:true}); }
