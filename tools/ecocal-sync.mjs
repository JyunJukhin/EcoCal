#!/usr/bin/env node
/* =========================================================================
 * ecocal-sync —— EcoCal 云备份本地中继（Mini WebDAV proxy）
 *
 * 为什么需要它：
 *   坚果云的 WebDAV 端点 (https://dav.jianguoyun.com/dav/) 不返回 CORS 头，
 *   纯网页 JS 直连会被浏览器拦截（Failed to fetch）。本工具在本机起一个
 *   HTTP 服务，把 EcoCal 发出的 WebDAV 请求原样转发到坚果云，并回传响应。
 *   因为目标地址变成了同源 http://127.0.0.1:<port>/，不存在跨域问题。
 *
 * 它的意义：
 *   - 认证（Basic）在「页面 → 本机」这一段是本地回环，不经过任何第三方；
 *   - 「本机 → 坚果云」这一段由本工具直接发起，密码不出本机、不落盘明文；
 *   - 自动备份 / 手动备份 / 恢复 / 目录递归全部沿用 EcoCal 已有逻辑，
 *     只是请求地址换了。
 *
 * 启动：  node tools/ecocal-sync.mjs            # 默认转发到坚果云
 *         端口 8470 可被 EcoCal 地址填为 http://127.0.0.1:8470/dav/
 * 目标：  默认 https://dav.jianguoyun.com/dav/ ，可用环境变量 ECOCAL_SYNC_TARGET 覆盖
 * 说明：  仅本机监听（127.0.0.1），不对外开放。
 * ========================================================================= */
'use strict';

import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.ECOCAL_SYNC_PORT || 8470);
// 默认转发到坚果云；测试时可指到本地假 WebDAV。目录前缀请求的拼接方式：
// 把目标端点视作「根」，后续路径原样透传，因此末尾斜杠含义与 WebDAV 一致。
const TARGET = (process.env.ECOCAL_SYNC_TARGET || 'https://dav.jianguoyun.com/dav/').replace(/\/+$/, '');

const server = http.createServer((req, res) => {
  // 只放行本机回环，避免把中继暴露给局域网/公网
  const addr = req.socket.remoteAddress || '';
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('仅允许本机访问');
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://127.0.0.1');
    const path = u.pathname.replace(/^\/dav\//, '/'); // EcoCal 填的是 /dav/ 前缀，映射到目标根
    const targetUrl = TARGET + path + u.search;
    const client = targetUrl.startsWith('https:') ? https : http;
    console.error('[ecocal-sync] 收到 ' + req.method + ' ' + req.url + ' → 转发 ' + targetUrl + ' body=' + body.length + 'B');

    // 只转发 WebDAV 需要的头（白名单）；其余（origin/sec-fetch-*/cookie 等）一律丢弃，
    // 避免把浏览器上下文无关头传给上游导致 400/异常。
    const upstreamHeaders = {};
    for (const k of ['authorization', 'content-type', 'depth', 'destination', 'overwrite']) {
      if (req.headers[k] != null) upstreamHeaders[k] = req.headers[k];
    }
    upstreamHeaders['Content-Length'] = body.length;

    const upstream = client.request(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
    }, upRes => {
      const parts = [];
      upRes.on('data', c => parts.push(c));
      upRes.on('end', () => {
        const fullBody = Buffer.concat(parts);
        if (upRes.statusCode && upRes.statusCode >= 400) {
          console.error('[ecocal-sync] 上游 ' + req.method + ' ' + path + ' → ' + upRes.statusCode + ' body: ' + fullBody.toString('utf8').slice(0, 300));
        }
        // 给响应补上 CORS 放行，方便将来改用 fetch 直连本中继时也能读响应
        res.writeHead(upRes.statusCode || 502, {
          ...upRes.headers,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, PUT, DELETE, MKCOL, PROPFIND, OPTIONS, HEAD',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth',
        });
        res.end(fullBody);
      });
    });
    upstream.on('error', e => {
      console.error('[ecocal-sync] 上游错误:', e.message);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('上游连接失败: ' + e.message);
    });
    if (body.length) upstream.write(body);
    upstream.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[ecocal-sync] 本地 WebDAV 中继已启动');
  console.log('  地址:  http://127.0.0.1:' + PORT + '/dav/');
  console.log('  转发到: ' + TARGET);
});
