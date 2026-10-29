// moyu 本地服务：解析播放地址、维持弹幕连接、提供播放页与发送接口。
// 只监听 127.0.0.1；页面通过 SSE 接收房间状态。

import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  roomInit,
  resolvePlayUrl,
  collectDanmaku,
  sendDanmaku,
  getRoomInfo,
  getNav,
  UA,
} from './bili.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

const PLAY_TTL = 10 * 60_000;

// 桌面悬浮窗（Electron）：按需启动，只有 DSH 面板点了才会拉起来
const DESKTOP_DIR = path.join(here, '..', '..', 'moyu-desktop');
const DESKTOP_BIN =
  process.platform === 'darwin'
    ? path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const CONFIG_PATH = process.env.MOYU_CONFIG || path.join(here, '..', '.data', 'config.json');

export function parseRoomInput(input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/);
  if (m) return Number(m[1]);
  return Number.NaN;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(next) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch {
    /* 配置存不下来不影响主流程 */
  }
}

export async function startDaemon({ roomId, jar, port = 8731, log = () => {} }) {
  const nav = await getNav(jar);
  let currentRoomId = (await roomInit(roomId)).roomId;

  const state = {
    roomId: currentRoomId,
    uid: nav.uid,
    uname: nav.uname,
    title: '',
    live: false,
    portrait: false,
    online: 0,
    playUrl: null,
    expiresAt: 0,
    updatedAt: Date.now(),
    openToken: 0,
    qn: 10000,
    flvUrl: null,
    hasFlv: false,
  };

  let lastDesktopSeen = 0;
  let pendingDesktopAction = null;

  function desktopOnline() {
    return Date.now() - lastDesktopSeen < 8000;
  }

  function spawnDesktop() {
    try {
      if (!fs.existsSync(DESKTOP_BIN)) return false;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(DESKTOP_BIN, [DESKTOP_DIR], {
        cwd: DESKTOP_DIR,
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  const clients = new Set();
  const pending = new Map(); // 文本 -> { resolve, timer }

  function broadcast(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(chunk);
      } catch {
        clients.delete(res);
      }
    }
  }

  async function refreshPlayUrl() {
    try {
      const [info, play] = await Promise.all([
        getRoomInfo(currentRoomId),
        resolvePlayUrl(currentRoomId, { qn: state.qn }),
      ]);
      state.title = info.title;
      state.portrait = info.isPortrait;
      state.online = info.online;
      state.live = info.liveStatus === 1;
      state.playUrl = play.live ? play.best.url : null;
      state.expiresAt = play.live ? play.best.expireAt : 0;

      // FLV 走本地转发：CDN 对带 Origin 的直连会 403，浏览器拉不了；
      // 但 FLV 延迟远低于 HLS（1 秒级 vs 6~8 秒），值得多这一跳。
      const flv = play.live
        ? play.streams.find(
            (x) => x.protocol === 'http_stream' && x.format === 'flv' && x.codec === 'avc',
          )
        : null;
      state.flvUrl = flv ? flv.url : null;
      state.hasFlv = Boolean(flv);
    } catch (e) {
      log(`刷新播放地址失败: ${e.message}`);
    }
    state.updatedAt = Date.now();
    broadcast('state', state);
  }

  await refreshPlayUrl();
  const refreshTimer = setInterval(refreshPlayUrl, PLAY_TTL);

  // ---- 弹幕连接：只为"发送回执"和在线人数兜底，断了就退避重连 ----
  let stopped = false;
  let backoff = 1000;
  let abortCurrent = null;

  async function danmakuLoop() {
    while (!stopped) {
      abortCurrent = new AbortController();
      const roomAtStart = currentRoomId;
      try {
        await collectDanmaku(currentRoomId, {
          seconds: 3600,
          signal: abortCurrent.signal,
          onAuth: () => {
            backoff = 1000;
            log(`弹幕连接已建立（房间 ${roomAtStart}）`);
          },
          onMessage: (m) => {
            if (process.env.MOYU_DEBUG === '1') log(`收到 [${m.uid}] ${m.user}: ${m.text}`);
            if (m.uid !== state.uid) return;
            const p = pending.get(m.text);
            if (p) {
              p.resolve(true);
              pending.delete(m.text);
              clearTimeout(p.timer);
            }
          },
        });
      } catch (e) {
        log(`弹幕连接断开: ${e.message}`);
      }
      if (!stopped) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
  danmakuLoop();

  function waitEcho(text, timeoutMs = 12_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(text);
        resolve(false);
      }, timeoutMs);
      pending.set(text, { resolve, timer });
    });
  }

  async function switchRoom(input) {
    const next = await roomInit(input);
    currentRoomId = next.roomId;
    state.roomId = next.roomId;
    state.live = next.liveStatus === 1;
    state.playUrl = null;
    await refreshPlayUrl();
    // 让弹幕连接重连到新房间
    try {
      abortCurrent?.abort();
    } catch {}
    const cfg = loadConfig();
    saveConfig({ ...cfg, roomId: currentRoomId, recent: [currentRoomId, ...(cfg.recent ?? []).filter((x) => x !== currentRoomId)].slice(0, 10) });
    log(`已切到房间 ${currentRoomId}`);
    return state;
  }

  // ---- HTTP ----
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveFile(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
      }
      if (url.pathname === '/live.flv') {
        return proxyFlv(req, res, state);
      }
      if (url.pathname === '/mpegts.js') {
        return serveFile(res, path.join(PUBLIC, 'mpegts.js'), 'text/javascript; charset=utf-8');
      }
      if (url.pathname === '/hls.min.js') {
        return serveFile(res, path.join(PUBLIC, 'hls.min.js'), 'text/javascript; charset=utf-8');
      }
      if (url.pathname === '/api/state') {
        return json(res, {
          ...state,
          jarOk: Boolean(jar.SESSDATA && jar.bili_jct),
          desktopOnline: desktopOnline(),
        });
      }
      if (url.pathname === '/api/desktop/hello' && req.method === 'POST') {
        lastDesktopSeen = Date.now();
        const action = pendingDesktopAction;
        pendingDesktopAction = null;
        return json(res, { ok: true, action });
      }
      if (url.pathname === '/api/desktop/bye' && req.method === 'POST') {
        lastDesktopSeen = 0;
        pendingDesktopAction = null;
        return json(res, { ok: true });
      }
      if (url.pathname === '/api/desktop/ping' && req.method === 'POST') {
        lastDesktopSeen = Date.now();
        return json(res, { ok: true });
      }
      // 桌面悬浮窗的开关：DSH 面板按一下，Electron 通过 SSE 收到后显示/隐藏
      if (url.pathname === '/api/desktop' && req.method === 'POST') {
        const body = await readJson(req);
        const action = ['toggle', 'show', 'hide'].includes(body.action) ? body.action : 'toggle';

        if (!desktopOnline()) {
          // 没在跑：拉起它，并把这次动作存下来，等它 hello 时回传
          const started = spawnDesktop();
          if (!started) return json(res, { ok: false, error: '找不到桌面程序（先 npm install）' }, 500);
          pendingDesktopAction = action;
          // 等它 hello 回来，起不来就明确报错，别让按钮点了没反应
          const t0 = Date.now();
          while (Date.now() - t0 < 8000 && !desktopOnline()) {
            await new Promise((r) => setTimeout(r, 300));
          }
          if (!desktopOnline()) {
            pendingDesktopAction = null;
            log('桌面程序启动失败（8 秒内没有 hello）');
            return json(res, { ok: false, error: '桌面程序没起来，看看 Terminal 里的报错' }, 500);
          }
          return json(res, { ok: true, action, starting: true });
        }

        state.desktopTicket = (state.desktopTicket ?? 0) + 1;
        broadcast('desktop', { action, ticket: state.desktopTicket });
        return json(res, { ok: true, action, ticket: state.desktopTicket });
      }
      if (url.pathname === '/api/qn' && req.method === 'POST') {
        const body = await readJson(req);
        const qn = Number(body.qn);
        if (![150, 250, 400, 10000].includes(qn)) {
          return json(res, { ok: false, error: '不支持的清晰度' }, 400);
        }
        state.qn = qn;
        await refreshPlayUrl();
        return json(res, { ok: true, qn: state.qn, playUrl: state.playUrl });
      }
      if (url.pathname === '/api/ui') {
        return json(res, { token: state.openToken });
      }
      if (url.pathname === '/api/ui/open' && req.method === 'POST') {
        state.openToken += 1;
        return json(res, { ok: true, token: state.openToken });
      }
      if (url.pathname === '/api/zhibo' && req.method === 'POST') {
        const body = await readJson(req);
        const input = String(body.input ?? '').trim();
        const room = parseRoomInput(input);
        if (input && !Number.isFinite(room)) {
          return json(res, { ok: false, error: `看不懂「${input}」：发直播间链接或房间号都行` }, 400);
        }
        try {
          if (Number.isFinite(room) && room !== currentRoomId) await switchRoom(room);
        } catch (e) {
          return json(res, { ok: false, error: e.message }, 400);
        }
        state.openToken += 1;
        return json(res, {
          ok: true,
          token: state.openToken,
          room: state.roomId,
          live: state.live,
          title: state.title,
        });
      }
      if (url.pathname === '/api/room' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const next = await switchRoom(body.room ?? body.roomId);
          return json(res, { ok: true, room: next });
        } catch (e) {
          return json(res, { ok: false, error: e.message }, 400);
        }
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        const isDesktop = url.searchParams.get('client') === 'desktop';
        clients.add(res);
        log(`页面已连接（当前 ${clients.size} 个${isDesktop ? '，桌面窗' : ''}）`);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {}
        }, 20_000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
          if (isDesktop) {
            lastDesktopSeen = 0;
            log('桌面窗已断开');
          }
        });
        return;
      }
      if (url.pathname === '/api/send' && req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, { ok: false, error: '空弹幕' }, 400);
        if ([...text].length > 40) return json(res, { ok: false, error: '超过 40 字上限' }, 400);
        if (!state.live) return json(res, { ok: false, error: '房间未开播' }, 400);
        if (!jar.SESSDATA || !jar.bili_jct) {
          return json(res, { ok: false, error: '没有登录态，先导入 cookie' }, 401);
        }

        const echo = waitEcho(text, 12_000);
        const r = await sendDanmaku({ roomId: currentRoomId, text, jar });
        if (r.code !== 0) {
          pending.delete(text);
          return json(res, { ok: false, code: r.code, error: explainCode(r.code) });
        }
        // 先回执，回显核对放后台；B 站对匿名连接的回显并不可靠，只记日志
        json(res, { ok: true, code: 0, echoed: null });
        echo.then((seen) => log(`回显: ${seen ? '已看到' : '未看到'}「${text}」`));
        return;
      }
      res.writeHead(404).end('not found');
    } catch (e) {
      if (!res.headersSent) json(res, { ok: false, error: e.message }, 500);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    port: server.address().port,
    state,
    async close() {
      stopped = true;
      clearInterval(refreshTimer);
      try {
        abortCurrent?.abort();
      } catch {}
      for (const res of clients) res.end();
      clients.clear();
      await new Promise((r) => server.close(r));
    },
  };
}

// FLV 转发：跟随重定向、带 Referer、给浏览器放开 CORS
function proxyFlv(req, res, state) {
  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const follow = (target, depth) => {
    if (closed || depth > 3) return;
    const client = String(target).startsWith('https:') ? https : http;
    const upstream = client.get(
      target,
      { headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/' } },
      (r) => {
        if ([301, 302, 303, 307].includes(r.statusCode ?? 0) && r.headers.location) {
          r.resume();
          follow(new URL(r.headers.location, target).toString(), depth + 1);
          return;
        }
        if (r.statusCode !== 200) {
          r.resume();
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`upstream ${r.statusCode}`);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/x-flv',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        r.pipe(res);
        r.on('end', () => log('FLV 上游结束'));
        r.on('error', (e) => {
          log(`FLV 上游错误: ${e.message}`);
          res.end();
        });
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('upstream error');
    });
  };
  follow(state.flvUrl, 0);
}

function explainCode(code) {
  const map = {
    '-101': '未登录（SESSDATA 失效）',
    '-111': 'csrf 失效（bili_jct 不对）',
    '-400': '参数错误',
    '-403': '账号被限制',
    '-412': '被风控拦截',
    10030: '发送过于频繁',
  };
  return map[String(code)] ?? `未知错误 code=${code}`;
}

function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 10_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}
