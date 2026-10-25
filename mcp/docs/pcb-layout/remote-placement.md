# Remote placement solver

`make_pcb_layout` runs eda-copilot-backend's placement solver, which needs a CUDA or Vulkan runtime. On a host without one, such as macOS, run the solver on a Linux GPU host through the remote placement service. Only `make_pcb_layout` moves; EasyEDA, the bridge, DSL validation, assembly and routing stay local.

If `remote-placement.local.md` exists beside this file, read it first. It holds this installation's SSH arguments, checkout path and service details, and is never committed.

## Connect before placement

1. **Check the service.** `curl -fsS http://127.0.0.1:18787/health` returns JSON with `protocol` and `backendVersion`. A refused connection means the SSH tunnel is closed.
2. **Open the tunnel when needed.** From an easyeda-copilot checkout, run `EASYEDA_PLACEMENT_SSH='<ssh arguments>' sh remote-placement/remote-placement.sh tunnel`. If the tunnel opens but `/health` still fails, the service is stopped; run the same script with `up` instead, which starts the service, opens the tunnel and prints `/health`. Without a checkout, open the forward directly with `ssh -f -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18787:127.0.0.1:18787 <ssh arguments> </dev/null >/dev/null 2>&1`; redirect all three streams so the backgrounded ssh does not hold the caller open. Ask the user for the SSH arguments when no local file provides them.
3. **Start the daemon with the endpoint.** `EASYEDA_COPILOT_PLACEMENT_URL=http://127.0.0.1:18787 node /absolute/path/to/skill/scripts/easyeda-copilot-cli.js start`. The daemon reads the variable only at start: a daemon started without it places locally and fails on such a host. Start a new daemon for this task instead of stopping another task's daemon. Add `EASYEDA_COPILOT_PLACEMENT_TOKEN` when the service requires a bearer token.

Then follow the ordinary [placement workflow](instructions.md). Validation, previews, assembly and verification are unchanged.

## While it runs

- Expect `status: "running"` and call `wait_operation` until terminal, as described in [operations](../operations.md). The service streams progress and sends a heartbeat every 15 seconds, so a long silent board-packing stage is not a hang.
- Large boards take minutes, not seconds: a 364-component board took about 21 minutes, of which board packing was about 17. Small boards finish much sooner. The first job after a service deploy also compiles GPU kernels and runs longer.
- `cancel_operation` closes the stream, which cancels the remote job.

## Failures

| Message | Action |
|---|---|
| `Cannot reach the remote placement service` | Open the tunnel or start the service as above, then retry. |
| `Remote placement runs eda-copilot-backend X, but this MCP uses Y` or a protocol mismatch | The service must run the same backend version as this skill. Redeploy it with `remote-placement.sh deploy` from a checkout of the matching version; never bypass the check. |
| `Missing real footprint for <designator>` | The backend could not resolve that part's footprint, for example a project-local footprint the EasyEDA library does not serve. `solver({ ignoreComponents: [...] })` excludes such parts but turns the run into a preview that cannot be assembled; report the parts and place them separately. |

Setup, deployment and service tuning are documented in the repository's `remote-placement/README.md`.
