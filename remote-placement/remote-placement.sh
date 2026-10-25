#!/bin/sh
# Deploy and reach the remote PCB placement service on a CUDA/Vulkan host.
#
#   EASYEDA_PLACEMENT_SSH='-J root@jump.example -p 28029 root@localhost' \
#     remote-placement/remote-placement.sh deploy|build-backend|start|stop|restart|tunnel|untunnel|status|logs|up|env FILE
#
# Then start EasyEDA Copilot with EASYEDA_COPILOT_PLACEMENT_URL=http://127.0.0.1:18787
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
: "${EASYEDA_PLACEMENT_SSH:?Set EASYEDA_PLACEMENT_SSH to the ssh arguments that reach the GPU host.}"
remote_dir=${EASYEDA_PLACEMENT_REMOTE_DIR:-/mnt/workspace/easyeda-placement}
port=${EASYEDA_PLACEMENT_PORT:-18787}
local_port=${EASYEDA_PLACEMENT_LOCAL_PORT:-$port}
forward="127.0.0.1:$local_port:127.0.0.1:$port"

# The SSH arguments are intentionally split into words.
# shellcheck disable=SC2086
remote() { ssh -o BatchMode=yes -o ConnectTimeout=20 $EASYEDA_PLACEMENT_SSH "$@"; }

backend_version() {
    node -p "require('$repo/node_modules/eda-copilot-backend/package.json').version"
}

host() { remote "EASYEDA_PLACEMENT_PORT=$port EASYEDA_PLACEMENT_TOKEN='${EASYEDA_PLACEMENT_TOKEN:-}' sh '$remote_dir/app/host.sh' $*"; }

tunnel_pid() { pgrep -f -- "-L $forward" || true; }

health() { curl -fsS -m 10 ${EASYEDA_PLACEMENT_TOKEN:+-H "authorization: Bearer $EASYEDA_PLACEMENT_TOKEN"} "http://127.0.0.1:$local_port/health"; }

case "${1:-}" in
build-backend)
    # Build a local eda-copilot-backend checkout on the GPU host; prints the spec for deploy.
    src=${EASYEDA_PLACEMENT_BACKEND_SRC:?Set EASYEDA_PLACEMENT_BACKEND_SRC to an eda-copilot-backend checkout.}
    remote "rm -rf '$remote_dir/backend-src' && mkdir -p '$remote_dir/backend-src' '$remote_dir/app'"
    remote "cat > '$remote_dir/app/host.sh'" <"$here/host.sh"
    (cd "$src" && COPYFILE_DISABLE=1 tar -czf - --no-xattrs --no-mac-metadata --exclude=node_modules \
        --exclude=target --exclude=.git --exclude='native/pcb-board-packer/*.node' .) |
        remote "tar -xzf - -C '$remote_dir/backend-src'"
    mirrors=""
    # npm_config_<package>_binary_host_mirror redirects prebuilt native downloads (e.g. canvas).
    for name in RUST_DIST_MIRROR CARGO_SPARSE_MIRROR NPM_REGISTRY npm_config_canvas_binary_host_mirror; do
        eval "value=\${$name:-}"
        if [ -n "$value" ]; then mirrors="$mirrors $name='$value'"; fi
    done
    remote "$mirrors sh '$remote_dir/app/host.sh' build-backend"
    ;;
deploy)
    # A custom backend build (from build-backend) must keep the version the MCP pins.
    version=${EASYEDA_PLACEMENT_BACKEND_SPEC:-$(backend_version)}
    remote "mkdir -p '$remote_dir/app'"
    remote "cat > '$remote_dir/app/server.mjs'" <"$here/server.mjs"
    remote "cat > '$remote_dir/app/host.sh'" <"$here/host.sh"
    printf '{\n  "name": "easyeda-copilot-placement",\n  "private": true,\n  "type": "module",\n  "dependencies": {\n    "eda-copilot-backend": "%s"\n  }\n}\n' "$version" |
        remote "cat > '$remote_dir/app/package.json'"
    host install
    echo "Deployed eda-copilot-backend $version to $remote_dir/app"
    ;;
start | stop | logs)
    host "$@"
    ;;
restart)
    host stop
    host start
    ;;
env)
    # Solver tuning read by host.sh at start, e.g. PCB_GPU_RUNTIME=vulkan.
    : "${2:?usage: $0 env FILE}"
    remote "cat > '$remote_dir/service.env'" <"$2"
    echo "Uploaded $2 to $remote_dir/service.env; run restart to apply it"
    ;;
tunnel)
    if [ -n "$(tunnel_pid)" ]; then
        echo "tunnel already open on 127.0.0.1:$local_port"
    else
        # The backgrounded ssh must not hold the caller's stdout/stderr open.
        # shellcheck disable=SC2086
        ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
            -o ServerAliveCountMax=3 -L "$forward" $EASYEDA_PLACEMENT_SSH </dev/null >/dev/null 2>&1
        if [ -z "$(tunnel_pid)" ]; then
            echo "could not open the tunnel; check EASYEDA_PLACEMENT_SSH and that 127.0.0.1:$local_port is free" >&2
            exit 1
        fi
        echo "tunnel open on 127.0.0.1:$local_port"
    fi
    ;;
untunnel)
    pid=$(tunnel_pid)
    if [ -n "$pid" ]; then kill $pid && echo "tunnel closed"; else echo "no tunnel"; fi
    ;;
status)
    health
    echo
    ;;
up)
    host start
    "$0" tunnel
    health
    echo
    ;;
*)
    echo "usage: $0 deploy|build-backend|start|stop|restart|tunnel|untunnel|status|logs|up|env FILE" >&2
    exit 2
    ;;
esac
