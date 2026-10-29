// Host 半：把 /moyu/* 同源转发到本地 moyu 守护进程（127.0.0.1:8731）。
// 这样播放页和 DSH 页面同源，iframe 内嵌不受 CSP / 跨域限制。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.MOYU_PORT ?? 8731);

// 这个 bundle 装在 workspace 里，moyu 核心就在它隔壁
const BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(BUNDLE_DIR, '..');
const MOYU_BIN = path.join(WORKSPACE, 'moyu', 'bin', 'moyu.mjs');
const MOYU_DIR = path.join(WORKSPACE, 'moyu');
const JAR_CANDIDATES = [
  process.env.MOYU_JAR,
  path.join(WORKSPACE, 'moyu', '.cookie.json'),
  path.join(WORKSPACE, 'moyu-spike', '.cookie.json'), // 早期路径
].filter(Boolean);
const JAR = JAR_CANDIDATES.find((p) => fs.existsSync(p)) || JAR_CANDIDATES[1] || JAR_CANDIDATES[0];

export const inject = ['webServer', 'commands'];

export function apply(ctx) {
  registerDmCommand(ctx);
  registerZhiboCommand(ctx);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/moyu',
        handler: (req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          const suffix = url.pathname.replace(/^\/moyu/, '') || '/';
          const upstream = http.request(
            {
              host: UPSTREAM_HOST,
              port: UPSTREAM_PORT,
              method: req.method,
              path: suffix + url.search,
              headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
            },
            (r) => {
              res.writeHead(r.statusCode ?? 502, r.headers);
              r.pipe(res);
            },
          );
          upstream.on('error', () => {
            if (res.headersSent) return res.end();
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
              '<!doctype html><meta charset="utf-8">' +
                '<meta http-equiv="refresh" content="2">' +
                '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
                'background:#0e0f13;color:#8b91a1;font:13px/1.6 -apple-system,PingFang SC,sans-serif">' +
                '<div>moyu 守护进程没在跑，正在自动重试…<br>' +
                '<span style="color:#6b7280">终端执行：cd moyu && node bin/moyu.mjs play --no-open</span></div>' +
                '</body>',
            );
          });
          req.pipe(upstream);
        },
      }),
    'moyu-live routes',
  );
}

// ---- /dm：在 DSH 主输入框里直接发弹幕 ----
// commands 的契约明确写着"执行后不发给模型"，所以这条消息既不会进对话，也不会花 token。
// 聊天里只会留一行命令记录，看起来就像在跑一个工具。
function sendDanmaku(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const req = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method: 'POST',
        path: '/api/send',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('moyu 返回了非 JSON 响应'));
          }
        });
      },
    );
    req.on('error', () => reject(new Error('moyu 守护进程没在跑')));
    req.end(body);
  });
}

export function registerDmCommand(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'dm',
        description: '把这条输入当作弹幕发出去（不会发给模型）',
        input: { hint: '弹幕内容' },
        handler: async (invocation) => {
          const text = String(invocation.rawInput ?? '').trim();
          if (!text) return { kind: 'error', text: '弹幕不能为空，用法：/dm 内容' };
          if ([...text].length > 40) return { kind: 'error', text: '超过 B 站 40 字上限' };
          try {
            const d = await sendDanmaku(text);
            if (!d.ok) return { kind: 'error', text: d.error ?? '发送失败' };
            return { kind: 'success', text: '已发送弹幕' };
          } catch (e) {
            return { kind: 'error', text: e.message };
          }
        },
      }),
    'moyu /dm command',
  );
}

// ---- 守护进程生命周期 ----
function call(method, apiPath, payload, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method,
        path: apiPath,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('守护进程返回了非 JSON 响应'));
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error('timeout'));
    }, timeoutMs);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('close', () => clearTimeout(timer));
    req.end(body ?? undefined);
  });
}

async function daemonState() {
  try {
    return await call('GET', '/api/state', undefined, 800);
  } catch {
    return null;
  }
}

function spawnDaemon() {
  // detached + unref：DSH 重启不会把直播一起带走
  // DSH 桌面版跑在 Electron 里，process.execPath 是 App 本体；
  // ELECTRON_RUN_AS_NODE=1 让它以 Node 身份执行脚本（普通 node 会忽略这个变量）。
  const child = spawn(process.execPath, [MOYU_BIN, 'play', '--no-open'], {
    cwd: MOYU_DIR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MOYU_JAR: JAR },
  });
  child.unref();
}

async function waitDaemon(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const st = await daemonState();
    if (st) return st;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// ---- /zhibo：起直播 / 换直播间 ----
export function registerZhiboCommand(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'zhibo',
        description: '打开直播小窗；带直播间链接或房间号则切换过去',
        input: { hint: '直播间链接或房间号（可留空，用上次的）' },
        handler: async (invocation) => {
          const input = String(invocation.rawInput ?? '').trim();

          let st = await daemonState();
          if (!st) {
            try {
              spawnDaemon();
            } catch (e) {
              return { kind: 'error', text: `起不来：${e.message}` };
            }
            st = await waitDaemon();
            if (!st) return { kind: 'error', text: '守护进程 15 秒内没起来，检查 cookie 是否还在' };
          }

          try {
            const r = await call('POST', '/api/zhibo', { input }, 20000);
            if (!r.ok) return { kind: 'error', text: r.error ?? '切换失败' };
            return {
              kind: 'success',
              text: `直播间 ${r.room}${r.live ? ' 直播中' : ' 未开播'}：${r.title ?? ''}`,
            };
          } catch (e) {
            return { kind: 'error', text: `请求失败：${e.message}` };
          }
        },
      }),
    'moyu /zhibo command',
  );
}
