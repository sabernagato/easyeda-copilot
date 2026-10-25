#!/bin/sh
# GPU-host half of remote-placement.sh. Installed next to server.mjs.
set -eu

app=$(cd "$(dirname "$0")" && pwd)
dir=$(dirname "$app")
node_version=${NODE_VERSION:-22.18.0}
node_dir="$dir/opt/node-v$node_version-linux-x64"
pid_file="$dir/server.pid"
log_file="$dir/server.log"

running() { [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; }

case "${1:-}" in
install)
    if [ ! -x "$node_dir/bin/node" ]; then
        mirror=${NODE_MIRROR:-https://npmmirror.com/mirrors/node}
        archive="node-v$node_version-linux-x64.tar.xz"
        mkdir -p "$dir/opt"
        cd "$dir/opt"
        curl -fsSL -o "$archive" "$mirror/v$node_version/$archive"
        curl -fsSL "$mirror/v$node_version/SHASUMS256.txt" | grep " $archive\$" | sha256sum -c -
        tar -xJf "$archive"
        rm "$archive"
    fi
    cd "$app"
    PATH="$node_dir/bin:$PATH" npm install --omit=dev --no-audit --no-fund \
        --registry="${NPM_REGISTRY:-https://registry.npmmirror.com}"
    ;;
start)
    if running; then
        echo "already running (pid $(cat "$pid_file"))"
        exit 0
    fi
    # Host-local solver tuning (PCB_GPU_RUNTIME, PCB_*_BACKEND, profiling), one KEY=VALUE per line.
    if [ -f "$dir/service.env" ]; then
        set -a
        . "$dir/service.env"
        set +a
    fi
    # The Vulkan loader expects a runtime directory even when headless.
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/easyeda-placement-runtime}"
    mkdir -p "$XDG_RUNTIME_DIR"
    chmod 700 "$XDG_RUNTIME_DIR"
    cd "$app"
    setsid nohup "$node_dir/bin/node" server.mjs >>"$log_file" 2>&1 </dev/null &
    echo $! >"$pid_file"
    sleep 2
    if running; then
        echo "started (pid $(cat "$pid_file"))"
    else
        tail -n 20 "$log_file"
        exit 1
    fi
    ;;
stop)
    if running; then
        kill "$(cat "$pid_file")"
        echo "stopped"
    else
        echo "not running"
    fi
    rm -f "$pid_file"
    ;;
logs)
    tail -n "${2:-50}" "$log_file"
    ;;
*)
    echo "usage: host.sh install|start|stop|logs [lines]" >&2
    exit 2
    ;;
esac
