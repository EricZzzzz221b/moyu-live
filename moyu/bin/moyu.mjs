#!/usr/bin/env node
// moyu CLI：起本地服务并打开播放页。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startDaemon } from '../src/daemon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.MOYU_CONFIG || path.join(here, '..', '.data', 'config.json');

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'play';
const rest = cmd === args[0] ? args.slice(1) : args;

function flag(name, fallback) {
  const i = rest.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = rest[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      if (rest[i + 1] && !rest[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(rest[i]);
  }
  return out;
}

const JAR_CANDIDATES = [
  process.env.MOYU_JAR,
  path.join(here, '..', '.cookie.json'),
  path.resolve('.cookie.json'),
  path.resolve('../moyu-spike/.cookie.json'), // 早期开发路径，兼容用
].filter(Boolean);

function loadJar() {
  const explicit = flag('jar', null);
  const file = explicit || JAR_CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) {
    console.error('找不到 cookie 文件。先跑：node bin/auth.mjs');
    console.error('或用 --jar <path> 指定');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 直播间链接 / 裸房间号 → 房间号 */
function parseRoomInput(input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/);
  if (m) return Number(m[1]);
  return Number.NaN;
}

const rawRoom = positional()[0] ?? readConfig().roomId;
const roomArg = parseRoomInput(rawRoom);
if (!Number.isFinite(roomArg)) {
  console.error('用法: moyu play <房间号|直播间链接> [--port 8731] [--no-open]');
  process.exit(1);
}

const jar = loadJar();
const port = Number(flag('port', 8731));

const daemon = await startDaemon({
  roomId: roomArg,
  jar,
  port,
  log: (m) => console.log('[moyu]', m),
});

try {
  const prev = readConfig();
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        ...prev,
        roomId: daemon.state.roomId,
        recent: [
          daemon.state.roomId,
          ...(prev.recent ?? []).filter((x) => x !== daemon.state.roomId),
        ].slice(0, 10),
      },
      null,
      2,
    ),
  );
} catch {}

console.log(`[moyu] 播放页: ${daemon.url}`);
console.log(`[moyu] 房间: ${daemon.state.roomId} | 账号: ${daemon.state.uname ?? '未登录'}`);

if (!flag('no-open', false)) {
  execFile('open', [daemon.url], () => {});
}

const stop = async () => {
  await daemon.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
