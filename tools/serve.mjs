/* =========================================================================
 * EcoCal 本地静态服务器
 * 用途：
 *   1) 本地验证 Service Worker / PWA 离线能力（SW 只能在 http 下注册）；
 *   2) 手机同 WiFi 下试用：启动后手机访问 http://<电脑IP>:<端口>。
 * 用法：node tools/serve.mjs [目录] [端口]     （默认目录=项目根，端口=8123）
 * ========================================================================= */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const filePath = normalize(join(root, urlPath));
    // 路径穿越防护：必须位于 root 之内
    if (!filePath.startsWith(root)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      // 开发期不缓存，避免浏览器/手机缓存旧文件
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found: ' + e.code);
  }
}).listen(port, '0.0.0.0', () => {
  console.log('EcoCal 静态服务器已启动:');
  console.log('  本机访问   http://localhost:' + port);
  console.log('  手机访问   http://<本机IP>:' + port + '   （同一 WiFi，可用 ipconfig 查看本机IP）');
});
