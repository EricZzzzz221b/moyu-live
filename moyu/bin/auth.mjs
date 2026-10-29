#!/usr/bin/env node
// 从本机 Chrome 读取 bilibili 登录态，写入 moyu/.cookie.json（权限 600）。
// 只取发弹幕真正需要的几个字段，不打印明文。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFromChrome, saveJar, missingKeys, selfTest } from '../src/cookies.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.MOYU_JAR || path.join(here, '..', '.cookie.json');

if (process.argv.includes('--self-test')) {
  console.log('cookie 解密自检:', selfTest());
  process.exit(0);
}

try {
  const { jar, profile } = importFromChrome();
  const miss = missingKeys(jar);
  if (miss.length) {
    console.error(`❌ Chrome 的 bilibili cookie 缺少: ${miss.join(', ')}`);
    console.error('   先在 Chrome 打开 bilibili.com 并登录');
    process.exit(1);
  }
  saveJar(jar, target);
  console.log(`✅ 已写入 ${target}（profile=${profile}，字段 ${Object.keys(jar).join(' / ')}）`);
} catch (e) {
  const msg = `${e.message} ${e.code ?? ''}`;
  console.error('❌ 读取失败:', e.message);
  if (/EPERM|EACCES|operation not permitted/i.test(msg)) {
    console.error('   原因：终端没有「完全磁盘访问权限」，读不了 Chrome 的数据目录。');
    console.error('   办法：系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 添加你的终端，重启终端再试。');
  }
  process.exit(1);
}
