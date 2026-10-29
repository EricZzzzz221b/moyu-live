window.__ModuleLoader__.load({
  id: '@local/moyu-live',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const savedOpacity = (() => {
      try {
        const v = Number(localStorage.getItem('moyu.opacity'));
        return v >= 0.3 && v <= 1 ? v : 1;
      } catch {
        return 1;
      }
    })();

    // visible: 面板是否展开；mounted: iframe 是否已经挂载（一旦挂载就不再卸载）
    // audioOnly: 黑听——面板收起但声音继续
    const store = { visible: false, mounted: false, audioOnly: false, inputOpen: false, opacity: savedOpacity };
    const subs = new Set();
    const emit = () => {
      for (const f of subs) f();
    };
    const patch = (next) => {
      Object.assign(store, next);
      emit();
    };

    function useStore() {
      const [, tick] = React.useState(0);
      React.useEffect(() => {
        const f = () => tick((n) => n + 1);
        subs.add(f);
        return () => {
          subs.delete(f);
        };
      }, []);
      return store;
    }

    const frame = { current: null };

    function withVideo(fn) {
      try {
        const doc = frame.current && frame.current.contentDocument;
        const video = doc && doc.querySelector('video');
        if (video) fn(video);
      } catch {
        /* 跨文档访问失败就只做界面切换 */
      }
    }

    function setQuality(qn) {
      fetch('/moyu/api/qn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qn }),
      }).catch(() => {});
    }

    /** 黑听：收起面板，声音继续（iframe 不卸载） */
    function listenOnly() {
      patch({ visible: false, mounted: true, audioOnly: true });
      withVideo((v) => {
        v.muted = false;
        v.play().catch(() => {});
      });
      setQuality(150);
    }

    /** 展开面板 */
    function showPanel() {
      const wasAudioOnly = store.audioOnly;
      patch({ visible: true, mounted: true, audioOnly: false });
      withVideo((v) => {
        v.play().catch(() => {});
      });
      if (wasAudioOnly) setQuality(10000);
    }

    /** 真·收起：静音 + 暂停（给双击 Esc 用） */
    function panic() {
      withVideo((v) => {
        v.pause();
        v.muted = true;
      });
      patch({ visible: false, audioOnly: false });
    }

    let lastEsc = 0;
    function handleEsc(e) {
      if (e.key !== 'Escape') return;
      const now = Date.now();
      if (now - lastEsc < 400) {
        lastEsc = 0;
        if (store.visible) panic();
        else if (store.audioOnly) showPanel();
        else if (store.mounted) showPanel();
      } else {
        lastEsc = now;
      }
    }

    const boundDocs = new Set();
    function bindDoc(doc) {
      if (!doc || boundDocs.has(doc)) return;
      doc.addEventListener('keydown', onFrameKey, true);
      boundDocs.add(doc);
    }
    function onFrameKey(e) {
      handleEsc(e);
    }

    const panelStyle = {
      position: 'fixed',
      right: 18,
      bottom: 18,
      width: 440,
      height: 366,
      display: 'flex',
      flexDirection: 'column',
      background: '#12141a',
      border: '1px solid rgba(255,255,255,0.14)',
      borderRadius: 12,
      overflow: 'hidden',
      boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
      pointerEvents: 'auto',
      zIndex: 60,
    };

    const barStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      height: 30,
      padding: '0 6px 0 10px',
      background: '#181b23',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      color: '#cfd4e0',
      fontSize: 12,
      userSelect: 'none',
      flex: '0 0 auto',
    };

    const inputBarStyle = {
      position: 'fixed',
      left: '50%',
      bottom: 90,
      transform: 'translateX(-50%)',
      width: 460,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 10px',
      background: 'rgba(18,20,26,0.97)',
      border: '1px solid rgba(255,255,255,0.14)',
      borderRadius: 12,
      boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
      pointerEvents: 'auto',
      zIndex: 70,
    };

    const footStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 8px',
      background: '#181b23',
      borderTop: '1px solid rgba(255,255,255,0.08)',
      flex: '0 0 auto',
    };

    const inputStyle = {
      flex: 1,
      background: '#0f1116',
      border: '1px solid rgba(255,255,255,0.1)',
      color: '#f0f2f7',
      borderRadius: 8,
      padding: '6px 10px',
      fontSize: 13,
      outline: 'none',
    };

    const sendBtn = {
      background: '#4f8cff',
      border: '1px solid #4f8cff',
      color: '#fff',
      borderRadius: 8,
      padding: '6px 10px',
      fontSize: 12,
      cursor: 'pointer',
    };

    const iconBtn = {
      background: 'transparent',
      border: 0,
      color: '#9aa2b4',
      cursor: 'pointer',
      fontSize: 14,
      lineHeight: '22px',
      padding: '0 6px',
      borderRadius: 6,
      textDecoration: 'none',
      display: 'inline-block',
    };

    let lastToken = 0;

    const inputRef = { current: null };
    const barRef = { current: null };

    function Moyu() {
      const s = useStore();
      const [hover, setHover] = React.useState(false);
      const [text, setText] = React.useState('');
      const [barText, setBarText] = React.useState('');
      const [muted, setMuted] = React.useState(true);

      function postToFrame(type) {
        try {
          const win = frame.current && frame.current.contentWindow;
          if (win) win.postMessage({ type }, '*');
        } catch {}
      }

      function toggleSound() {
        const next = !muted;
        setMuted(next);
        postToFrame(next ? 'moyu:mute' : 'moyu:unmute');
      }

      async function submitBar() {
        const value = barText.trim();
        if (!value) return;
        setBarText('');
        try {
          await fetch('/moyu/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: value }),
          });
        } catch {}
        setTimeout(() => patch({ inputOpen: false }), 500);
      }

      async function submit() {
        const value = text.trim();
        if (!value) return;
        setText('');
        try {
          const r = await fetch('/moyu/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: value }),
          });
          const d = await r.json();
          if (!d.ok) {
            setText(value);
            console.warn('moyu 发送失败:', d.error);
          }
        } catch (e) {
          setText(value);
        }
      }

      // iframe 里如果是"守护进程没在跑"之类的错误页，自动重载，别一直挂着
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (!store.visible || !frame.current) return;
          try {
            const doc = frame.current.contentDocument;
            if (!doc || doc.getElementById('video')) return;
            frame.current.src = '/moyu/?embed=1&t=' + Date.now();
          } catch {}
        }, 4000);
        return () => clearInterval(timer);
      }, []);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const r = await fetch('/moyu/api/ui', { cache: 'no-store' });
            const d = await r.json();
            if (!alive) return;
            if (typeof d.token === 'number' && d.token > lastToken) {
              lastToken = d.token;
              if (!store.visible) showPanel();
            }
          } catch {
            /* 守护进程没起就安静等着 */
          }
        };
        tick();
        const id = setInterval(tick, 2500);
        return () => {
          alive = false;
          clearInterval(id);
        };
      }, []);

      const chip = h(
        'div',
        { style: { position: 'fixed', right: 18, bottom: 18, pointerEvents: 'auto', zIndex: 60 } },
        h(
          'button',
          {
            type: 'button',
            title: s.audioOnly ? '黑听中：声音继续，点一下看画面' : '打开直播（双击 Esc 收起）',
            onClick: showPanel,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              width: 36,
              height: 36,
              borderRadius: 18,
              border: s.audioOnly
                ? '1px solid rgba(79,140,255,0.75)'
                : '1px solid rgba(255,255,255,0.16)',
              background: 'rgba(24,27,35,0.92)',
              color: '#cfd4e0',
              cursor: 'pointer',
              fontSize: 15,
              opacity: hover ? 1 : s.audioOnly ? 0.9 : 0.55,
              transition: 'opacity .15s',
              boxShadow: s.audioOnly ? '0 0 12px rgba(79,140,255,0.45)' : 'none',
            },
          },
          s.audioOnly ? '🎧' : '📺',
        ),
      );

      // 一旦挂载就不再卸载 iframe：收起时只是 display:none，声音才能继续
      const panel = s.mounted
        ? h(
            'div',
            {
              style: {
                ...panelStyle,
                display: s.visible ? 'flex' : 'none',
                opacity: s.opacity,
              },
            },
            h(
              'div',
              { style: barStyle },
              h('span', null, '直播'),
              h('span', { style: { color: '#6b7280' } }, '双击 Esc 收起'),
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', style: iconBtn, title: '声音', onClick: toggleSound }, s.muted ? '🔇' : '🔊'),
              h(
                'button',
                { type: 'button', style: iconBtn, title: '黑听：收起窗口，声音继续', onClick: listenOnly },
                '🎧',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: iconBtn,
                  title: '显示桌面置顶窗口',
                  onClick: () => {
                    fetch('/moyu/api/desktop', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'toggle' }),
                    }).catch(() => {});
                  },
                },
                '🖥',
              ),
              h('input', {
                type: 'range',
                min: 30,
                max: 100,
                value: Math.round(s.opacity * 100),
                title: '透明度',
                'aria-label': '透明度',
                onChange: (e) => {
                  const v = Number(e.target.value) / 100;
                  patch({ opacity: v });
                  try {
                    localStorage.setItem('moyu.opacity', String(v));
                  } catch {}
                },
                style: { width: 66, accentColor: '#4f8cff', cursor: 'pointer' },
              }),
              h('button', { type: 'button', style: iconBtn, title: '收起', onClick: panic }, '—'),
            ),
            // 画面区域不接收鼠标：点击直接穿透到 DSH 界面
            h('iframe', {
              ref: (el) => {
                frame.current = el;
                if (el) bindDoc(el.contentDocument);
              },
              onLoad: (e) => bindDoc(e.currentTarget.contentDocument),
              src: '/moyu/?embed=1&bare=1',
              title: 'moyu live',
              allow: 'autoplay; fullscreen; popup',
              style: {
                flex: 1,
                border: 0,
                display: 'block',
                background: '#000',
                width: '100%',
                pointerEvents: 'none',
              },
            }),
            h(
              'div',
              { style: footStyle },
              h('input', {
                ref: (el) => {
                  inputRef.current = el;
                },
                value: text,
                maxLength: 40,
                placeholder: '发条弹幕，回车发送',
                onChange: (e) => setText(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') submit();
                },
                style: inputStyle,
              }),
              h('button', { type: 'button', style: sendBtn, onClick: submit }, '发送'),
            ),
          )
        : null;

      // 不要用 React.Fragment：动态 Client 运行时不保证暴露它，
      // 一旦是 undefined，整个浮窗会渲染失败（表现为"画面没了"）。
      const inputBar = s.inputOpen
        ? h(
            'div',
            { style: inputBarStyle },
            h('input', {
              ref: (el) => {
                barRef.current = el;
              },
              value: barText,
              maxLength: 40,
              placeholder: '发条弹幕，回车发送，Esc 关闭',
              onChange: (e) => setBarText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') submitBar();
                if (e.key === 'Escape') patch({ inputOpen: false });
              },
              style: inputStyle,
            }),
            h('button', { type: 'button', style: sendBtn, onClick: submitBar }, '发送'),
          )
        : null;

      return h('div', { style: { display: 'contents' } }, panel, s.visible ? null : chip, inputBar);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'moyu-live', order: 5 }, Moyu),
        );

        ctx.effect(() => {
          const onWindowKey = (e) => handleEsc(e);

          // ⌘D：桌面窗口在跑时由它的全局热键负责；没跑时在这里打开面板输入框。
          // 两边都持有，但同一时刻只有一边会响应。
          const onCmdD = async (e) => {
            if (!(e.metaKey || e.ctrlKey) || String(e.key).toLowerCase() !== 'd') return;
            if (e.shiftKey || e.altKey) return;
            e.preventDefault();
            try {
              const st = await fetch('/moyu/api/state', { cache: 'no-store' }).then((r) => r.json());
              if (st && st.desktopOnline) return;
            } catch {}
            // 只弹输入条：黑听/收起状态下不该把画面拉回来
            patch({ inputOpen: true });
            setTimeout(() => {
              if (barRef.current) barRef.current.focus();
            }, 30);
          };

          window.addEventListener('keydown', onWindowKey, true);
          window.addEventListener('keydown', onCmdD, true);
          return () => {
            window.removeEventListener('keydown', onWindowKey, true);
            window.removeEventListener('keydown', onCmdD, true);
            for (const doc of boundDocs) {
              try {
                doc.removeEventListener('keydown', onFrameKey, true);
              } catch {}
            }
            boundDocs.clear();
          };
        }, 'moyu-live hotkey');
      },
    };
  },
});
