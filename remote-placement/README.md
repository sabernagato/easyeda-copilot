# Remote PCB placement

`make_pcb_layout` runs eda-copilot-backend's placement solver, whose GPU paths need CUDA or Vulkan. A Mac has neither, so this folder moves only that solver to a Linux GPU host. EasyEDA, the bridge, DSL validation and routing stay on the local machine.

```text
EasyEDA ── ws 127.0.0.1:8787 ── MCP / skill daemon ── http 127.0.0.1:18787 ══ SSH -L ══ GPU host 127.0.0.1:18787 (server.mjs)
```

The service binds to loopback on the GPU host and is reached only through an SSH local forward. It installs the same `eda-copilot-backend` version as this checkout, and the MCP refuses a mismatched service so both sides place identically.

## Set up

Requirements on the GPU host: x64 Linux with glibc 2.35 or newer, an NVIDIA driver with its Vulkan ICD (or a CUDA toolkit), `curl`, and internet access to the Node mirror, the npm registry and EasyEDA's footprint API.

```sh
export EASYEDA_PLACEMENT_SSH='-J root@jump.example -p 28029 root@localhost'
remote-placement/remote-placement.sh deploy   # Node + eda-copilot-backend under /mnt/workspace/easyeda-placement
remote-placement/remote-placement.sh up       # start the service, open the tunnel, print /health
```

Then start the MCP or skill daemon with the endpoint in its environment:

```sh
EASYEDA_COPILOT_PLACEMENT_URL=http://127.0.0.1:18787 node /path/to/skill/scripts/easyeda-copilot-cli.js start
```

Unset the variable to place locally again.

## Operate

| Command | Effect |
|---|---|
| `deploy` | Upload the service and install the pinned backend; rerun after upgrading eda-copilot-backend. |
| `up` / `start` / `stop` / `restart` | Manage the service on the GPU host (`up` also opens the tunnel). |
| `tunnel` / `untunnel` | Open or close the local forward. |
| `status` | Print the service's `/health` through the tunnel. |
| `logs [lines]` | Show the service log. |
| `env FILE` | Upload solver tuning read at start, for example `PCB_GPU_RUNTIME=vulkan`; apply with `restart`. |

`EASYEDA_PLACEMENT_REMOTE_DIR`, `EASYEDA_PLACEMENT_PORT` and `EASYEDA_PLACEMENT_LOCAL_PORT` override the defaults. Set `EASYEDA_PLACEMENT_TOKEN` here and `EASYEDA_COPILOT_PLACEMENT_TOKEN` in the MCP environment to require a bearer token as well.

The first job after a deploy compiles the solver's GPU kernels into `~/.cache/eda-copilot/gpu-kernels` on the host and takes noticeably longer. The backend chooses CPU or GPU per stage from measured workload thresholds, so small boards may not touch the GPU at all.
