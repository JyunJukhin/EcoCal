/**
 * EcoCal 云备份验证用：极简 WebDAV 假服务器（验证用，不属于产品代码）。
 * 支持 MKCOL / PUT / GET / DELETE / OPTIONS；Basic 认证（账号 test / 密码 secret）；
 * 所有响应带完整 CORS 头（模拟"允许网页直连"的端点，如自建网盘）。
 * 用法：node tools/mock-webdav.mjs [端口]（默认 8901）
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8901);
// 数据目录放临时目录（验证用完即弃；避免污染仓库）
const DATA = join(root, '.wdtest-data');

const USERS = { test: 'secret' }; // 测试账号（与设置面板输入一致）

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PROPFIND,MKCOL,PUT,GET,DELETE,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Depth,Destination,Overwrite');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');
}

function unauth(res) {
  cors(res);
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock-webdav"' });
  res.end('unauthorized');
}

function parseAuth(req) {
  const h = req.headers.authorization || '';
  if (!/^Basic /i.test(h)) return null;
  const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = dec.indexOf(':');
  if (i < 0) return null;
  return { user: dec.slice(0, i), pass: dec.slice(i + 1) };
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].replace(/^\/+/, ''));
  const abs = normalize(join(DATA, sep, decoded));
  if (!abs.startsWith(normalize(DATA) + sep) && abs !== normalize(DATA)) return null;
  return abs;
}

const server = createServer((req, res) => {
  // 统一处理跨域预检
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const auth = parseAuth(req);
  if (!auth || USERS[auth.user] !== auth.pass) return unauth(res);

  cors(res);
  const p = safePath(req.url || '/');
  if (p === null) { res.writeHead(403); res.end('forbidden'); return; }

  switch (req.method) {
    case 'MKCOL': {
      if (existsSync(p)) { res.writeHead(405); res.end('exists'); return; }
      mkdirSync(p, { recursive: true });
      res.writeHead(201); res.end('');
      return;
    }
    case 'PUT': {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, Buffer.concat(chunks));
        res.writeHead(201); res.end('');
      });
      return;
    }
    case 'GET': {
      if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(readFileSync(p));
      return;
    }
    case 'DELETE': {
      if (!existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
      rmSync(p, { recursive: true, force: true });
      res.writeHead(204); res.end('');
      return;
    }
    default: {
      res.writeHead(501); res.end('unsupported method ' + req.method);
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('mock WebDAV listening: http://127.0.0.1:' + port + '/');
});
