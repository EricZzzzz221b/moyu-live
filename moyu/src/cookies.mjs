// 从本机 Chrome 读取 bilibili.com 的 cookie（只读，只落地发送弹幕需要的字段）。
// 用 node:sqlite 直接读库：BLOB 拿到的就是原始字节，不走文本转换。

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WANTED = ['SESSDATA', 'bili_jct', 'buvid3', 'buvid4'];

const CHROME_DIR = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function chromeCookieDbs() {
  const out = [];
  const profiles = ['Default', ...safeReaddir(CHROME_DIR).filter((n) => n.startsWith('Profile'))];
  for (const p of profiles) {
    const db = path.join(CHROME_DIR, p, 'Cookies');
    if (fs.existsSync(db)) out.push({ profile: p, db });
  }
  return out;
}

function keychainPassword() {
  // Chrome 在 macOS 上把 cookie 主密钥放在 Keychain；可能弹系统授权框
  return execFileSync(
    'security',
    ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
    { encoding: 'utf8' },
  ).trim();
}

export function deriveKey(password) {
  // Chrome macOS: PBKDF2-SHA1, salt 'saltysalt', 1003 轮, 16 字节
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

export function decryptValue(encrypted, key, hostKey) {
  if (!encrypted?.length) return '';
  const prefix = Buffer.from(encrypted).subarray(0, 3).toString('utf8');
  if (prefix === 'v20') {
    throw new Error('该 cookie 使用 v20 应用绑定加密，无法直接解密，请改用手动粘贴');
  }
  if (prefix !== 'v10') return Buffer.from(encrypted).toString('utf8');

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(Buffer.from(encrypted).subarray(3)), decipher.final()]);
  const pad = plain[plain.length - 1];
  if (pad > 0 && pad <= 16) plain = plain.subarray(0, plain.length - pad);
  // Chrome 24+ 会在明文前加 host_key 的 SHA256（32 字节）
  if (plain.length > 32) {
    const hash = crypto.createHash('sha256').update(hostKey).digest();
    if (plain.subarray(0, 32).equals(hash)) plain = plain.subarray(32);
  }
  return plain.toString('utf8');
}

function readCookies(dbPath, key) {
  // 复制一份再读，避免 Chrome 正在写入时锁库
  const tmp = path.join(os.tmpdir(), `moyu-cookies-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(dbPath, tmp);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, tmp + ext);
  }
  let rows = [];
  try {
    const db = new DatabaseSync(tmp, { readOnly: true });
    rows = db
      .prepare(
        'select host_key, name, value, encrypted_value from cookies ' +
          "where host_key like '%bilibili%'",
      )
      .all();
    db.close();
  } finally {
    for (const p of [tmp, tmp + '-wal', tmp + '-shm']) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }

  const jar = {};
  for (const row of rows) {
    if (!WANTED.includes(row.name) || jar[row.name]) continue;
    try {
      const value =
        row.value || decryptValue(row.encrypted_value, key, row.host_key);
      if (value) jar[row.name] = value;
    } catch {
      /* 单条失败忽略，最后用 missingKeys 报告 */
    }
  }
  return jar;
}

/**
 * 依次尝试所有 Chrome profile，返回第一个拿到 SESSDATA 的 jar。
 */
export function importFromChrome() {
  const candidates = chromeCookieDbs();
  if (!candidates.length) throw new Error('没找到 Chrome 的 Cookies 数据库');
  const key = deriveKey(keychainPassword());
  for (const c of candidates) {
    const jar = readCookies(c.db, key);
    if (jar.SESSDATA) return { jar, profile: c.profile };
  }
  throw new Error('Chrome 里没有已登录的 bilibili cookie，请先在 Chrome 打开 bilibili.com 登录');
}

export function saveJar(jar, file) {
  fs.writeFileSync(file, JSON.stringify(jar, null, 2), { mode: 0o600 });
  return file;
}

export function loadJar(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function missingKeys(jar) {
  return ['SESSDATA', 'bili_jct'].filter((k) => !jar?.[k]);
}

/** 不碰真 Chrome 的自检：造一条 v10 密文，验证解密逻辑与打码逻辑 */
export function selfTest() {
  const password = 'test-password';
  const key = deriveKey(password);
  const hostKey = '.bilibili.com';
  const plain = 'fake-sessdata-value';
  const padded = Buffer.concat([
    crypto.createHash('sha256').update(hostKey).digest(),
    Buffer.from(plain),
  ]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const enc = Buffer.concat([Buffer.from('v10'), cipher.update(padded), cipher.final()]);
  const got = decryptValue(enc, key, hostKey);
  if (got !== plain) throw new Error(`自检失败: ${got}`);
  return 'ok';
}
