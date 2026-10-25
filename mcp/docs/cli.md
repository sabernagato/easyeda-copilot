# CLI and portable skill

The CLI exposes the same tools and JSON Schemas as MCP. Prefer an available standalone CLI skill, including when direct MCP tools are also connected. Direct MCP tools remain supported when the skill is unavailable or the user requests MCP. Existing MCP configurations are unchanged. Node.js >=20.19 and the EasyEDA Copilot extension are required; use the Node executable supplied by your agent if it is not on PATH.

For ordinary tasks, use the existing generated or installed skill and start its daemon as shown below. Building and dependency installation are setup or update steps, not steps to repeat for each task.

## Commands

```bash
easyeda-copilot-cli start
# prints a four-character ID, for example a7k2
easyeda-copilot-cli a7k2 tools list
easyeda-copilot-cli a7k2 tools help make_pcb_layout
easyeda-copilot-cli a7k2 tools help validate_pcb_dsl
easyeda-copilot-cli a7k2 call validate_pcb_dsl --input validation.json
easyeda-copilot-cli a7k2 call get_current_project_info
easyeda-copilot-cli a7k2 call make_pcb_layout --input layout.json
easyeda-copilot-cli a7k2 call wait_operation --input operation.json
easyeda-copilot-cli a7k2 status
easyeda-copilot-cli a7k2 stop
```

In a source checkout, substitute `node /absolute/path/to/mcp/dist/cli.js` for `easyeda-copilot-cli`. In a portable skill use `node /absolute/path/to/skill/scripts/easyeda-copilot-cli.js`. No global CLI installation is necessary.

Each task starts a separate daemon and retains its ID. Daemons use the existing owner/proxy bridge on localhost:8787 alongside stdio MCP processes. No HTTP listener or operating-system service is installed. CLI requests use a local named pipe on Windows or Unix socket on Linux/macOS. State and logs are stored under `~/.easyeda-copilot/cli`; `EASYEDA_COPILOT_CLI_HOME` overrides that location. An ID identifies a daemon, not an OS PID or authentication secret.

When the environment that runs `start` sets `EASYEDA_COPILOT_PLACEMENT_URL` (for example `http://127.0.0.1:18787`), `make_pcb_layout` runs the placement solver on that remote CUDA/Vulkan host instead of locally; every other tool, including validation and routing, stays local. The daemon checks that the remote service runs the same `eda-copilot-backend` version and fails with the tunnel command when the service is unreachable. Set the variable for hosts without a usable GPU runtime, such as macOS; the repository's `remote-placement/` folder deploys the service. See the [remote placement guide](pcb-layout/remote-placement.md) for connecting, long runs and failures.

Omitted tool input is `{}`. Supply a JSON object with `--input file.json` or `--json '{"key":"value"}'`; these options are mutually exclusive. The JSON file is resolved in the calling terminal; use absolute paths for paths inside tool arguments because the daemon retains its startup working directory. JSON Schema is obtained directly from MCP via `tools help`, including required properties and defaults.

Results are JSON on stdout. Single text/JSON results are unwrapped; append `--raw` to retain the complete MCP response. Nonzero exit codes indicate command/protocol/tool errors; tool-specific error fields still need inspection. Logs/errors are written to stderr, and startup failures identify the daemon log file. Connection loss or timeout never retries a mutation. Closing or killing a `call` client cancels its active MCP request: ordinary commands stop cooperatively, while an already registered managed operation survives cancellation of the initial wait. Recover its ID with `list_operations`; use `cancel_operation` to stop the operation itself.

`stop` refuses active requests and long operations. `stop --force` interrupts this runtime, without rollback. A shared owner may remain as a broker after its CLI runtime stops, following the existing MCP lifecycle. Lost or stopped operation IDs cannot be resumed in a newly started daemon. Never stop another task's daemon just to finish your own task.

## Build a skill

Skip this section when a usable generated or installed skill already exists. Build only to create a missing skill or update it from changed source or to a new version. From the repository root, after installing dependencies:

```bash
npm run build:skill
```

The output is the ignored, generated `skill/` directory beside `mcp/`:

```text
mcp/
  docs/                     Single source for SKILL.md and its references
  src/                      MCP server and CLI source
  scripts/build-skill.mjs   Packages the current MCP build
skill/                      Generated installable folder; never edit it directly
  SKILL.md
  cli.md
  scripts/
  build-info.json
  install-guide.md
```

The builder first compiles the current MCP, then derives the skill from its npm pack list and copies `mcp/docs/` directly into the skill root. The CLI and stdio entry point both use the same `createServer` factory, so tool registration and schemas cannot drift between them. `build-info.json` records the MCP version, distribution mode, installation blockers, and packaged dependencies. Temporary staging stays under `mcp/` and is cleaned after handled failures.

The default `skill/` contains compiled MCP/CLI files, documentation, and a minimal runtime package.json, but **no node_modules**. Run `npm install --omit=dev` in the installed `scripts/runtime/` once during setup, or after replacing the skill with a new lightweight build; reuse installed dependencies for subsequent tasks. Direct dependency versions are pinned from the build environment; a registry-verified lockfile is not generated yet. Local file dependencies are recorded as installation blockers until maintainers publish them and switch source manifests to registry versions. No compiler should be required by the final published native packages.

To repackage an already-built MCP use `npm run pack:skill --workspace=easyeda-copilot-mcp`. The generated folder is ignored by Git to avoid maintaining a second copy of MCP code and documentation. Rebuild it after changing MCP runtime code, docs, the launcher, or the installation guide.

For a self-contained local build, run `npm run pack:skill --workspace=easyeda-copilot-mcp -- --bundled`. It regenerates the same root `skill/` with production dependencies included. Native assets make this output platform-specific.

Release CI does not publish skill archives. Users build the skill from the repository so its generated runtime and documentation match the selected source revision. The optional `--bundled` mode remains available for a self-contained local build and is platform-specific because it includes native dependencies.

## Installation and updates

The single installation reference is [install-guide.md](install-guide.md), also copied to the root of a generated skill. It covers lightweight and bundled local builds, updates, and troubleshooting. Existing stdio MCP installation and updates are unchanged.
