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
build-backend)
    # Build the eda-copilot-backend checkout uploaded to $dir/backend-src,
    # including this host's native solver, and pack it under $dir/builds.
    # RUST_DIST_MIRROR (e.g. https://mirrors.aliyun.com/rustup) serves the stable
    # components; each is checked against static.rust-lang.org's own .sha256.
    export RUSTUP_HOME="$dir/opt/rust/rustup" CARGO_HOME="$dir/opt/rust/cargo"
    if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
        if [ -n "${RUST_DIST_MIRROR:-}" ]; then
            dist="$dir/opt/rust-dist"
            rm -rf "$dist"
            mkdir -p "$dist"
            manifest=$(curl -fsSL "$RUST_DIST_MIRROR/dist/channel-rust-stable.toml")
            for component in rustc cargo rust-std; do
                url=$(printf '%s\n' "$manifest" | sed -n -E "s#^xz_url = \"(.*/$component-[0-9.]+-x86_64-unknown-linux-gnu\.tar\.xz)\"#\1#p" | head -n 1)
                curl -fsSL -o "$dist/$(basename "$url")" "$url"
                curl -fsSL "$(printf '%s' "$url" | sed "s#^$RUST_DIST_MIRROR#https://static.rust-lang.org#").sha256" |
                    (cd "$dist" && sha256sum -c -)
                unpack="$dist/$component"
                mkdir -p "$unpack"
                tar -xJf "$dist/$(basename "$url")" -C "$unpack" --strip-components=1
                "$unpack/install.sh" --prefix="$CARGO_HOME" --disable-ldconfig
            done
        else
            curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
        fi
    fi
    if [ -n "${CARGO_SPARSE_MIRROR:-}" ]; then
        # Downloaded crates are still verified against Cargo.lock checksums.
        printf '[source.crates-io]\nreplace-with = "mirror"\n\n[source.mirror]\nregistry = "sparse+%s"\n' \
            "$CARGO_SPARSE_MIRROR" >"$CARGO_HOME/config.toml"
    else
        rm -f "$CARGO_HOME/config.toml"
    fi
    export PATH="$CARGO_HOME/bin:$node_dir/bin:$PATH"
    # Outside the re-uploaded source, so a rebuild only recompiles what changed.
    export CARGO_TARGET_DIR="$dir/cargo-target"
    cd "$dir/backend-src"
    npm ci --no-audit --no-fund --registry="${NPM_REGISTRY:-https://registry.npmmirror.com}"
    npm run build
    npm run native:build
    mkdir -p "$dir/builds"
    archive=$(npm pack --ignore-scripts --pack-destination "$dir/builds" | tail -n 1)
    echo "file:$dir/builds/$archive"
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
    echo "usage: host.sh install|build-backend|start|stop|logs [lines]" >&2
    exit 2
    ;;
esac
