#!/bin/bash
# 启动置顶播放器。输出同时写进 run.log，方便出问题时排查。
cd "$(dirname "$0")" || exit 1
# DSH 的终端环境里带着这个变量，不清掉 Electron 会以纯 Node 模式启动（没有窗口）
unset ELECTRON_RUN_AS_NODE
LOG="$PWD/run.log"
{
  echo "===== $(date '+%F %T') ====="
  echo "daemon: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8731/api/state)"
} >> "$LOG"
exec ./node_modules/.bin/electron . "$@" >> "$LOG" 2>&1
