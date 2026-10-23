/**
 * EcoCal 云备份验证用：Gitee API 假服务器（验证用，不属于产品代码）。
 * 模拟 Gitee v5 API 的关键行为：
 *   GET  /api/v5/user?access_token=x            → 200 {login,name} / 401
 *   GET  /api/v5/repos/{owner}/{repo}           → 200 {full_name} / 404
 *   GET  /api/v5/repos/{owner}/{repo}/contents/{path}   → 200 {sha,content(base64)} / 404
 *   POST /api/v5/repos/{owner}/{repo}/contents/{path}   → 201（form: access_token,content,message）
 *   PUT  /api/v5/repos/{owner}/{repo}/contents/{path}   → 200（需 sha）
 * CORS 头与真实 Gitee 一致：ACAO:*、ACM 全方法、ACH authorization,content-type。
 * 用法：node tools/mock-gitee.mjs [端口]（默认 8902）
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8902);
const VALID_TOKEN = 'test-token-abc';
const OWNER = 'testuser';
const REPO = 'ecocal-backup';

// 文件存储：path → base64 字符串
const files = new Map();

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, status, obj) {
  cors(res);
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  cors(res);
  const method = req.method || 'GET';
  const url = req.url || '/';
  const u = new URL(url, 'http://x');

  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 读取 body（form）
  let body = '';
  if (method === 'POST' || method === 'PUT') {
    for await (const chunk of req) body += chunk;
  }
  const form = new URLSearchParams(body);

  // 令牌：query 或 form 均可
  const token = u.searchParams.get('access_token') || form.get('access_token') || '';

  const authFail = () => json(res, 401, { message: '令牌无效：access token does not exist' });

  const pathname = decodeURIComponent(u.pathname);

  if (pathname === '/api/v5/user') {
    if (token !== VALID_TOKEN) return authFail();
    return json(res, 200, { id: 1, login: OWNER, name: '测试用户' });
  }

  const repoMatch = pathname.match(/^\/api\/v5\/repos\/([^/]+)\/([^/]+)\/?$/);
  const contentsMatch = pathname.match(/^\/api\/v5\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);

  if (repoMatch && !contentsMatch) {
    if (token !== VALID_TOKEN) return authFail();
    const [, owner, repo] = repoMatch;
    if (owner !== OWNER || repo !== REPO) return json(res, 404, { message: 'Not Found Project' });
    return json(res, 200, { full_name: owner + '/' + repo, private: true });
  }

  if (contentsMatch) {
    if (token !== VALID_TOKEN) return authFail();
    const [, owner, repo, filePath] = contentsMatch;
    if (owner !== OWNER || repo !== REPO) return json(res, 404, { message: 'Not Found Project' });

    if (method === 'GET') {
      if (!files.has(filePath)) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, { name: filePath.split('/').pop(), path: filePath, sha: 'sha-' + Buffer.from(filePath).toString('hex'), content: files.get(filePath), encoding: 'base64' });
    }

    if (method === 'POST' || method === 'PUT') {
      const content = form.get('content') || '';
      const message = form.get('message') || '';
      const sha = form.get('sha') || '';
      const exists = files.has(filePath);
      if (method === 'POST' && exists) return json(res, 409, { message: '文件已存在：请使用 PUT 并携带 sha' });
      if (method === 'PUT' && !exists) return json(res, 422, { message: '文件不存在：请先使用 POST 创建' });
      if (method === 'PUT' && sha !== 'sha-' + Buffer.from(filePath).toString('hex')) return json(res, 400, { message: 'sha 不匹配' });
      files.set(filePath, content);
      return json(res, method === 'POST' ? 201 : 200, { content: { path: filePath, sha: 'sha-' + Buffer.from(filePath).toString('hex'), content, encoding: 'base64' }, commit: { message } });
    }

    return json(res, 405, { message: 'Method Not Allowed' });
  }

  return json(res, 404, { message: 'Not Found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log('[mock-gitee] listening on http://127.0.0.1:' + port + '（token: ' + VALID_TOKEN + '，仓库: ' + OWNER + '/' + REPO + '）');
});
