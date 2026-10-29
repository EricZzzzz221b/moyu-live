// 用 Electron 离屏渲染一张 README 用的效果图
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const out = path.join(__dirname, '..', 'docs', 'screenshot.png');
const target = process.argv[2] || 'preview.html';
const W = Number(process.argv[3] || 900);
const H = Number(process.argv[4] || 720);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '2');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    backgroundColor: '#111318',
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'docs', target));
  await new Promise((r) => setTimeout(r, 1200));
  const image = await win.capturePage();
  fs.writeFileSync(out, image.toPNG());
  console.log('saved', out, image.getSize());
  app.quit();
});
