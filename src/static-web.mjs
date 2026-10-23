// 生产环境只提供构建产物，不暴露开发服务器或源码
import fs from 'node:fs/promises';
import path from 'node:path';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export function createStaticWeb(root) {
  return {
    middlewares(req, res, next) {
      void (async () => {
        let pathname;
        try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); res.end(); return; }
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
        const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(404); res.end(); return; }
        try {
          const data = await fs.readFile(file);
          res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(req.method === 'HEAD' ? undefined : data);
        } catch (error) {
          if (['ENOENT', 'EISDIR'].includes(error.code)) { res.writeHead(404); res.end(); } else next(error);
        }
      })();
    },
    async close() {},
  };
}
