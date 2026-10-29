// 最小可用的 B 站直播协议封装：取播放地址、收弹幕、发弹幕。
// 只依赖 Node 22 内置能力（fetch / WebSocket / zlib / crypto）。

import zlib from 'node:zlib';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LIVE_ORIGIN = 'https://live.bilibili.com';

export function cookieHeader(jar = {}) {
  return Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function getJson(url, jar = {}, extra = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${LIVE_ORIGIN}/`,
      ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
      ...extra,
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应 (${res.status}): ${text.slice(0, 200)}`);
  }
}

/** 短号 / 长号 → 真实房间号 */
export async function roomInit(roomId) {
  const d = await getJson(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`);
  if (d.code !== 0) throw new Error(`room_init 失败: ${d.code} ${d.message ?? d.msg}`);
  return {
    roomId: d.data.room_id,
    shortId: d.data.short_id,
    uid: d.data.uid,
    liveStatus: d.data.live_status, // 0 未开播 1 直播中 2 轮播
    encrypted: !!d.data.encrypted,
  };
}

/** 播放地址：挑一条 HLS（浏览器 hls.js 可直连，实测无需 Referer） */
export async function resolvePlayUrl(roomId, { qn = 10000 } = {}) {
  const q = new URLSearchParams({
    room_id: String(roomId),
    protocol: '0,1',
    format: '0,1,2',
    codec: '0,1',
    qn: String(qn),
    platform: 'web',
    ptype: '8',
  });
  const d = await getJson(
    `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${q}`,
  );
  if (d.code !== 0) throw new Error(`getRoomPlayInfo 失败: ${d.code} ${d.message}`);

  const info = d.data.playurl_info;
  if (!info) return { live: false, streams: [] };

  const streams = [];
  for (const s of info.playurl.stream) {
    for (const f of s.format) {
      for (const c of f.codec) {
        const host = c.url_info?.[0];
        if (!host) continue;
        streams.push({
          protocol: s.protocol_name, // http_stream | http_hls
          format: f.format_name, // flv | ts | fmp4
          codec: c.codec_name, // avc | hevc
          quality: c.current_qn,
          url: host.host + c.base_url + host.extra,
          expireAt: Number(new URLSearchParams(host.extra).get('expires') ?? 0) * 1000,
        });
      }
    }
  }
  // 优先 http_hls + ts + avc：兼容性最好
  const hls =
    streams.find((s) => s.protocol === 'http_hls' && s.format === 'ts' && s.codec === 'avc') ??
    streams.find((s) => s.protocol === 'http_hls');
  return { live: true, best: hls, streams };
}

/** 弹幕服务器 + token（老端点，免签名；getDanmuInfo 会被 -352 风控） */
export async function danmuConf(roomId, jar = {}) {
  const d = await getJson(
    `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
    jar,
  );
  if (d.code !== 0) throw new Error(`getConf 失败: ${d.code} ${d.message ?? d.msg}`);
  const hosts = d.data.host_server_list ?? d.data.server_list ?? [];
  const withWss = hosts.filter((h) => h.wss_port);
  const pick = withWss[0] ?? hosts[0] ?? { host: d.data.host, wss_port: 443 };
  return {
    token: d.data.token,
    hosts: hosts.map((h) => `${h.host}:${h.wss_port ?? h.port}`),
    url: `wss://${pick.host}:${pick.wss_port ?? 443}/sub`,
  };
}

// ---------- 弹幕 WebSocket 协议 ----------

function encode(op, body) {
  // 认证包体需要补空格到 4 字节对齐
  let text = body;
  while (Buffer.byteLength(text) % 4 !== 0) text += ' ';
  const payload = Buffer.from(text);
  const buf = Buffer.alloc(16 + payload.length);
  buf.writeUInt32BE(buf.length, 0); // 总长度
  buf.writeUInt16BE(16, 4); // 头部长度
  buf.writeUInt16BE(1, 6); // 协议版本
  buf.writeUInt32BE(op, 8); // 操作码
  buf.writeUInt32BE(1, 12); // 序号
  payload.copy(buf, 16);
  return buf;
}

function decode(buf) {
  const packets = [];
  let off = 0;
  while (off + 16 <= buf.length) {
    const total = buf.readUInt32BE(off);
    if (total < 16 || off + total > buf.length) break;
    const headerLen = buf.readUInt16BE(off + 4);
    const version = buf.readUInt16BE(off + 6);
    const op = buf.readUInt32BE(off + 8);
    const body = buf.subarray(off + headerLen, off + total);
    try {
      if (version === 2) packets.push(...decode(zlib.inflateSync(body)));
      else if (version === 3) packets.push(...decode(zlib.brotliDecompressSync(body)));
      else packets.push({ op, version, body });
    } catch {
      /* 单包解压失败不影响其它包 */
    }
    off += total;
  }
  return packets;
}

/**
 * 连接弹幕服务器，收若干秒后断开。
 *
 * 注意：认证包里的 uid 必须保持 0。传真实 uid 但不带 cookie 时，服务端会
 * 静默不回任何包（连接成功、认证无响应、收不到弹幕），实测踩过。
 * 需要"以登录身份"收弹幕时，authBody 里要同时带上 cookie 对应的凭证。
 *
 * @returns {Promise<{messages: Array<{user:string,text:string}>, stats: object}>}
 */
export async function collectDanmaku(
  roomId,
  { seconds = 8, uid = 0, onMessage, onAuth, signal } = {},
) {
  const conf = await danmuConf(roomId);
  const messages = [];
  const stats = { connected: false, authReply: null, heartbeats: 0, packets: 0 };

  const ws = new WebSocket(conf.url);
  ws.binaryType = 'arraybuffer';

  // 外部可以主动掐断这条连接（用于"疑似假死时强制重连"）
  let onAbort;
  if (signal) {
    if (signal.aborted) throw new Error('aborted');
    onAbort = () => {
      try {
        ws.close();
      } catch {}
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const authBody = JSON.stringify({
    uid,
    roomid: roomId,
    protover: 3,
    platform: 'web',
    type: 2,
    key: conf.token,
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(encode(2, '[object Object]'));
      stats.heartbeats++;
    }
  }, 15_000); // B 站弹幕连接空转久了会被静默掐断，心跳别太稀

  return await new Promise((resolve) => {
    let connectTimer;
    let timer;
    const finish = () => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      clearTimeout(connectTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      try {
        ws.close();
      } catch {}
      resolve({ messages, stats });
    };
    timer = setTimeout(finish, seconds * 1000);
    // 连接一直建立不起来时要能自己收场，否则 CLI 会挂死
    connectTimer = setTimeout(() => {
      if (!stats.connected) {
        stats.connectTimeout = true;
        finish();
      }
    }, 8000);

    ws.addEventListener('open', () => {
      clearTimeout(connectTimer);
      stats.connected = true;
      ws.send(encode(7, authBody));
    });

    ws.addEventListener('message', (ev) => {
      const buf = Buffer.from(ev.data);
      for (const p of decode(buf)) {
        stats.packets++;
        if (p.op === 8) {
          stats.authReply = p.body.toString('utf8').slice(0, 120);
          onAuth?.(stats.authReply);
        }
        if (p.op !== 5) continue;
        let json;
        try {
          json = JSON.parse(p.body.toString('utf8'));
        } catch {
          continue;
        }
        if (json.cmd?.startsWith('DANMU_MSG')) {
          const text = json.info?.[1];
          // 注意：B 站会把部分昵称打码成 "埃***"，所以身份一律用 uid 判定
          const uid = json.info?.[2]?.[0] ?? 0;
          const user = json.info?.[2]?.[1] ?? '?';
          if (typeof text === 'string') {
            const item = { uid, user, text };
            messages.push(item);
            onMessage?.(item);
          }
        }
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish();
    });

    // 服务端可能主动断开；不接 close 的话外层重连逻辑永远不会触发，
    // 表现就是"守护进程还活着，但再也收不到弹幕 / 看不到自己的回显"
    ws.addEventListener('close', () => {
      stats.closed = true;
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * 发弹幕。返回 B 站原始 code，便于判定风控类型。
 * 常见 code: 0 成功 / -101 未登录 / -111 csrf 失效 / -400 参数错误
 *           -403 账号异常 / -412 风控拦截 / 10030 发送过快
 */
export async function sendDanmaku({ roomId, text, jar, color = 16777215 }) {
  if (!jar?.SESSDATA || !jar?.bili_jct) {
    throw new Error('缺少 SESSDATA 或 bili_jct，无法发送');
  }
  const body = new URLSearchParams({
    bubble: '0',
    msg: text,
    color: String(color),
    mode: '1',
    fontsize: '25',
    rnd: String(Math.floor(Date.now() / 1000)),
    roomid: String(roomId),
    csrf: jar.bili_jct,
    csrf_token: jar.bili_jct,
    web_location: '444.8',
    reply_mid: '0',
    room_type: '0',
    jumpfrom: '0',
    statistics: JSON.stringify({ appId: 100, platform: 5 }),
  });

  const res = await fetch('https://api.live.bilibili.com/msg/send', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${LIVE_ORIGIN}/${roomId}`,
      Origin: LIVE_ORIGIN,
      Cookie: cookieHeader(jar),
    },
    body,
  });
  const text2 = await res.text();
  try {
    return JSON.parse(text2);
  } catch {
    return { code: -1, message: `非 JSON 响应: ${text2.slice(0, 200)}` };
  }
}

/** 房间展示信息（老端点，免签名，不受 -352 影响） */
export async function getRoomInfo(roomId) {
  const d = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`);
  if (d.code !== 0) throw new Error(`get_info 失败: ${d.code} ${d.message ?? d.msg}`);
  const x = d.data;
  return {
    roomId: x.room_id,
    uid: x.uid,
    title: x.title ?? '',
    online: x.online ?? 0,
    liveStatus: x.live_status,
    isPortrait: Boolean(x.is_portrait),
    areaName: x.area_name ?? '',
    parentAreaName: x.parent_area_name ?? '',
  };
}

/** 当前登录账号 */
export async function getNav(jar = {}) {
  const d = await getJson('https://api.bilibili.com/x/web-interface/nav', jar, {
    Referer: 'https://www.bilibili.com/',
  });
  return {
    loggedIn: d.code === 0 && Boolean(d.data?.isLogin),
    uid: d.data?.mid ?? 0,
    uname: d.data?.uname ?? null,
  };
}

/** 诊断：确认登录态、能否拿到发送所需信息 */
export async function diagnose(jar = {}) {
  const out = {};
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', jar, {
    Referer: 'https://www.bilibili.com/',
  });
  out.loggedIn = nav.code === 0 && nav.data?.isLogin;
  out.uname = nav.data?.uname ?? null;
  out.uid = nav.data?.mid ?? 0;
  out.navCode = nav.code;

  // 新版弹幕信息端点（预计 -352，用来确认风控面）
  const danmuInfo = await getJson(
    'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=7734200&type=0',
    jar,
  );
  out.getDanmuInfoCode = danmuInfo.code;
  out.getDanmuInfoMessage = danmuInfo.message ?? danmuInfo.msg;
  return out;
}
