// moyu-desktop：跨平台（macOS / Windows）的置顶播放器 + 快速弹幕输入。
// 只负责窗口与热键；播放和发送仍由本地守护进程（127.0.0.1:8731）提供。

const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  screen,
  ipcMain,
  shell,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const DAEMON = process.env.MOYU_DAEMON || 'http://127.0.0.1:8731';
const HOST = '127.0.0.1';
const PORT = Number(new URL(DAEMON).port || 8731);
const isMac = process.platform === 'darwin';

// 守护进程：打包后放在 resources/moyu，开发时在仓库里
function daemonRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'moyu') : path.join(__dirname, '..', 'moyu');
}

function cookiePath() {
  return process.env.MOYU_JAR || path.join(app.getPath('userData'), '.cookie.json');
}

function probeDaemon(timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/api/state', timeout }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureDaemon() {
  if (await probeDaemon()) return true;
  const bin = path.join(daemonRoot(), 'bin', 'moyu.mjs');
  if (!fs.existsSync(bin)) {
    console.log('[moyu] 找不到守护进程脚本:', bin);
    return false;
  }
  // 用 Electron 自带 Node 跑守护进程，用户不需要另外装 Node
  const child = spawn(process.execPath, [bin, 'play', '--no-open'], {
    cwd: daemonRoot(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MOYU_JAR: cookiePath(),
      MOYU_CONFIG: path.join(app.getPath('userData'), 'moyu-config.json'),
    },
  });
  child.unref();

  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await probeDaemon()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const HOTKEY = {
  player: 'CommandOrControl+Shift+D',
  input: 'CommandOrControl+D',
  dimmer: 'CommandOrControl+Shift+[',
  brighter: 'CommandOrControl+Shift+]',
  onTop: 'CommandOrControl+Shift+T',
};

let playerWin = null;
let inputWin = null;
let tray = null;
let quitting = false;

const settings = { opacity: 1, alwaysOnTop: true, bounds: null };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {}
  settings.opacity = Math.min(1, Math.max(0.35, settings.opacity ?? 0.96));
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {}
}

// ---------------- 播放窗 ----------------

function createPlayer() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const bounds = settings.bounds || {
    width: 440,
    height: 340,
    x: Math.max(0, area.width - 480),
    y: Math.max(0, area.height - 400),
  };

  playerWin = new BrowserWindow({
    ...bounds,
    frame: false,
    title: '限时特惠 · 今日必看',
    hasShadow: true,
    resizable: true,
    minWidth: 280,
    minHeight: 220,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: '#0e0f13',
    webPreferences: {
      preload: path.join(__dirname, 'player-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 置顶窗口经常不在前台，默认节流会让画面一顿一顿的
      backgroundThrottling: false,
    },
  });

  applyOnTop();
  playerWin.setOpacity(settings.opacity);
  playerWin.loadFile(path.join(__dirname, 'player.html'));

  // 默认整窗穿透；交互恢复靠下面 startMouseWatch() 的坐标轮询
  playerWin.setIgnoreMouseEvents(true, { forward: true });

  const remember = () => {
    if (playerWin && !playerWin.isDestroyed()) settings.bounds = playerWin.getBounds();
  };
  playerWin.on('move', remember);
  playerWin.on('resize', remember);
  playerWin.on('closed', () => {
    playerWin = null;
    if (mouseTimer) clearInterval(mouseTimer);
    mouseTimer = null;
    saveSettings();
  });

}

function applyOnTop() {
  if (!playerWin) return;
  playerWin.setAlwaysOnTop(settings.alwaysOnTop, isMac ? 'floating' : 'screen-saver');
  if (isMac) playerWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

let listenMode = false;

function showPlayer() {
  if (!playerWin) createPlayer();
  listenMode = false;
  playerWin.show();
  playerWin.focus();
  applyOnTop();
  setInteractive(false);
  startMouseWatch();
  buildTray();
}

// 黑听：画面收起，声音继续（窗口隐藏不会停止播放）
function enterListen() {
  if (!playerWin) return;
  listenMode = true;
  playerWin.hide();
  buildTray();
}

function togglePlayer() {
  if (playerWin && playerWin.isVisible()) enterListen();
  else showPlayer();
}

function adjustOpacity(delta) {
  settings.opacity = Math.min(1, Math.max(0.35, Number((settings.opacity + delta).toFixed(2))));
  if (playerWin) playerWin.setOpacity(settings.opacity);
  saveSettings();
  buildTray();
  pushState();
}

function toggleOnTop() {
  settings.alwaysOnTop = !settings.alwaysOnTop;
  applyOnTop();
  saveSettings();
  buildTray();
  pushState();
}

// ---------------- 输入窗 ----------------

let shownAt = 0;

function createInput() {
  inputWin = new BrowserWindow({
    width: 560,
    height: 96,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  inputWin.loadFile(path.join(__dirname, 'input.html'));
  inputWin.setAlwaysOnTop(true, isMac ? 'floating' : 'screen-saver');
  if (isMac) inputWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 刚弹出时窗口还没拿到焦点，会立刻收到一次 blur；
  // 不设这个时间窗的话，主窗口不活跃时按 ⌘D 会"闪一下就消失"。
  inputWin.on('blur', () => {
    if (Date.now() - shownAt < 400) return;
    if (inputWin && inputWin.isVisible()) inputWin.hide();
  });
}

function toggleInput() {
  if (!inputWin) createInput();
  if (inputWin.isVisible()) {
    inputWin.hide();
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  inputWin.setPosition(Math.round(x + (width - 560) / 2), Math.round(y + height * 0.28));
  shownAt = Date.now();
  inputWin.show();
  // 应用是 accessory 模式、主窗口可能没在前台：必须主动抢一次焦点，
  // 否则输入框出来了但键盘输入进不到它里面。
  if (isMac) app.focus({ steal: true });
  inputWin.focus();
  inputWin.webContents.send('moyu:focus');
}

function postDaemon(apiPath, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body ?? {});
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: apiPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

// 告诉守护进程"我起来了"，并领回它攒下的动作（点了 🖥 才启动的情况）
async function helloDaemon() {
  const r = await postDaemon('/api/desktop/hello');
  if (r && r.action && r.action !== 'hide') showPlayer();
  setInterval(() => postDaemon('/api/desktop/ping'), 10000);
}

function sendDanmaku(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ text });
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        method: 'POST',
        path: '/api/send',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
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
            resolve({ ok: false, error: '守护进程返回了异常内容' });
          }
        });
      },
    );
    req.on('error', () => resolve({ ok: false, error: '守护进程没在跑' }));
    req.end(body);
  });
}

ipcMain.handle('moyu:send', async (_event, text) => sendDanmaku(String(text ?? '')));

function pushState() {
  if (!playerWin || playerWin.isDestroyed()) return;
  playerWin.webContents.send('moyu:state', {
    opacity: settings.opacity,
    alwaysOnTop: settings.alwaysOnTop,
  });
}

ipcMain.handle('moyu:opacity', (_event, delta) => {
  adjustOpacity(Number(delta) || 0.1);
  return { opacity: settings.opacity, alwaysOnTop: settings.alwaysOnTop };
});

ipcMain.handle('moyu:top', () => {
  toggleOnTop();
  return { opacity: settings.opacity, alwaysOnTop: settings.alwaysOnTop };
});

ipcMain.handle('moyu:state', () => ({
  opacity: settings.opacity,
  alwaysOnTop: settings.alwaysOnTop,
}));

let currentInteractive = null;
let mouseTimer = null;

function setInteractive(on) {
  if (currentInteractive === on) return;
  currentInteractive = on;
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.setIgnoreMouseEvents(!on, { forward: true });
  }
}

// macOS 上 setIgnoreMouseEvents 的 forward 只对 Windows 有效，
// 页面收不到 mousemove，所以改用全局坐标轮询：鼠标进入顶栏/底栏才恢复交互。
function startMouseWatch() {
  if (mouseTimer) clearInterval(mouseTimer);
  mouseTimer = setInterval(() => {
    if (!playerWin || playerWin.isDestroyed() || !playerWin.isVisible()) return;
    const point = screen.getCursorScreenPoint();
    const box = playerWin.getBounds();
    const inside =
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height;
    if (!inside) {
      setInteractive(false);
      return;
    }
    const overBar = point.y - box.y <= 44;
    const overFoot = box.y + box.height - point.y <= 46;
    setInteractive(overBar || overFoot);
  }, 60);
}

ipcMain.on('moyu:interactive', (_event, on) => {
  if (!playerWin || playerWin.isDestroyed()) return;
  playerWin.setIgnoreMouseEvents(!on, { forward: true });
});

ipcMain.on('moyu:listen', () => enterListen());

ipcMain.on('moyu:quit', () => {
  quitting = true;
  app.quit();
});

// DSH 面板上的开关 → 守护进程广播 desktop 事件 → 这里收下并执行
function subscribeDaemon() {
  const req = http.get(
    { host: HOST, port: PORT, path: '/api/stream?client=desktop' },
    (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (!ev || !data || ev[1] !== 'desktop') continue;
          let payload;
          try {
            payload = JSON.parse(data[1]);
          } catch {
            continue;
          }
          if (payload.action === 'hide') return;
          showPlayer();
        }
      });
      res.on('end', () => setTimeout(subscribeDaemon, 2000));
    },
  );
  req.on('error', () => setTimeout(subscribeDaemon, 3000));
}
ipcMain.on('moyu:hide', () => {
  if (inputWin) inputWin.hide();
});
ipcMain.on('moyu:open-player', () => showPlayer());

// ---------------- 托盘 ----------------

function buildTray() {
  if (!tray) {
    // macOS 用模板图（自动适配深浅色菜单栏），Windows 用彩色图
    const iconPath = path.join(__dirname, 'assets', isMac ? 'trayTemplate.png' : 'tray.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (isMac) icon.setTemplateImage(true);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip(listenMode ? 'moyu 黑听中（⌘⇧D 显示画面）' : 'moyu 直播（⌘⇧D 黑听）');
    tray.on('click', showPlayer);
  }

  const menu = Menu.buildFromTemplate([
    {
      label: listenMode ? '退出黑听（显示画面）' : '黑听（收起画面，声音继续）',
      accelerator: HOTKEY.player,
      click: togglePlayer,
    },
    { label: '快速发弹幕', accelerator: HOTKEY.input, click: toggleInput },
    { type: 'separator' },
    { label: '始终置顶', type: 'checkbox', checked: settings.alwaysOnTop, click: toggleOnTop },
    {
      label: `不透明度 ${Math.round(settings.opacity * 100)}%`,
      submenu: [1, 0.96, 0.85, 0.7, 0.55].map((v) => ({
        label: `${Math.round(v * 100)}%`,
        type: 'radio',
        checked: Math.abs(settings.opacity - v) < 0.01,
        click: () => {
          settings.opacity = v;
          if (playerWin) playerWin.setOpacity(v);
          saveSettings();
          buildTray();
        },
      })),
    },
    { type: 'separator' },
    {
      label: '导入登录态（从 Chrome）',
      click: async () => {
        const auth = path.join(daemonRoot(), 'bin', 'auth.mjs');
        if (!fs.existsSync(auth)) {
          dialog.showErrorBox('moyu', '找不到 auth.mjs，请用源码方式运行');
          return;
        }
        const child = spawn(process.execPath, [auth], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MOYU_JAR: cookiePath() },
        });
        let out = '';
        child.stdout.on('data', (c) => {
          out += c;
        });
        child.stderr.on('data', (c) => {
          out += c;
        });
        child.on('close', (code) => {
          if (code === 0) {
            dialog.showMessageBox({ message: '登录态已导入', detail: out.trim() });
          } else {
            dialog.showErrorBox('导入失败', out.trim() || '未知错误');
          }
        });
      },
    },
    { label: '在浏览器中打开播放页', click: () => shell.openExternal(`${DAEMON}/`) },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ---------------- 生命周期 ----------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPlayer());

  app.whenReady().then(async () => {
    loadSettings();
    const ok = await ensureDaemon();
    console.log('[moyu] 守护进程:', ok ? 'ready' : '未就绪');
    if (isMac && app.dock) app.dock.hide();

    console.log(`[moyu] ready | daemon=${DAEMON} | userData=${app.getPath('userData')}`);

    createPlayer();
    buildTray();
    subscribeDaemon();
    helloDaemon();

    // 兜底：托盘图标没建起来时保留 Dock 图标，留一个能找到程序的入口。
    if (!tray && isMac && app.dock) app.dock.show();

    const bind = (accel, fn) => {
      let ok = false;
      try {
        ok = globalShortcut.register(accel, fn);
      } catch (e) {
        console.log(`[moyu] hotkey ${accel} threw: ${e.message}`);
      }
      console.log(`[moyu] hotkey ${accel}: ${ok ? 'ok' : 'FAILED（被其它程序占用）'}`);
    };

    bind(HOTKEY.player, togglePlayer);
    bind(HOTKEY.input, toggleInput);
    bind(HOTKEY.dimmer, () => adjustOpacity(-0.1));
    bind(HOTKEY.brighter, () => adjustOpacity(0.1));
    bind(HOTKEY.onTop, toggleOnTop);

    if (playerWin) {
      playerWin.webContents.on('did-finish-load', () => console.log('[moyu] 播放页加载完成'));
    }
  });

  // 托盘常驻：关窗不退出
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    saveSettings();
    postDaemon('/api/desktop/bye');
  });
}
