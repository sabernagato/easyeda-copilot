import { createRequire } from "node:module";
import type { makePcbLayout, MakePcbLayoutInput, PcbLayoutProgress } from "eda-copilot-backend/pcb";

// Must match remote-placement/server.mjs.
const PROTOCOL = 1;
const HEALTH_TIMEOUT_MS = 10_000;

type LayoutResult = Awaited<ReturnType<typeof makePcbLayout>>;

type RemoteLayoutOptions = {
    edaEdition?: string;
    signal: AbortSignal;
    onProgress: (progress: PcbLayoutProgress) => void;
};

type StreamMessage =
    | { type: "progress"; progress: PcbLayoutProgress }
    | { type: "heartbeat" }
    | { type: "result"; result: LayoutResult; elapsedMs?: number }
    | { type: "error"; message: string };

/** The remote placement service, when EASYEDA_COPILOT_PLACEMENT_URL selects one. */
export function remotePlacementEndpoint(env: NodeJS.ProcessEnv = process.env): URL | undefined {
    const raw = env.EASYEDA_COPILOT_PLACEMENT_URL?.trim();
    if (!raw) return undefined;
    const url = new URL(raw);
    // Keep relative endpoint paths under any configured base path.
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
}

function localBackendVersion(): string {
    return createRequire(import.meta.url)("eda-copilot-backend/package.json").version;
}

function requestHeaders(env: NodeJS.ProcessEnv) {
    const token = env.EASYEDA_COPILOT_PLACEMENT_TOKEN?.trim();
    return {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
}

async function fetchOrExplain(endpoint: URL, path: string, init: RequestInit) {
    try {
        return await fetch(new URL(path, endpoint), init);
    } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason ?? error;
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
        throw new Error(`Cannot reach the remote placement service at ${endpoint.origin} (${cause}). `
            + "Check that the GPU host service and its SSH tunnel are up: remote-placement/remote-placement.sh up");
    }
}

async function checkService(endpoint: URL, env: NodeJS.ProcessEnv, signal: AbortSignal) {
    const response = await fetchOrExplain(endpoint, "health", {
        headers: requestHeaders(env),
        signal: AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`Remote placement health check failed: HTTP ${response.status} ${await response.text()}`);
    const health = await response.json() as { protocol?: number; backendVersion?: string };
    const backendVersion = localBackendVersion();
    if (health.protocol !== PROTOCOL) {
        throw new Error(`Remote placement service speaks protocol ${health.protocol}; this MCP needs ${PROTOCOL}. Redeploy remote-placement.`);
    }
    if (health.backendVersion !== backendVersion) {
        throw new Error(`Remote placement runs eda-copilot-backend ${health.backendVersion}, but this MCP uses ${backendVersion}. `
            + "Redeploy with remote-placement/remote-placement.sh deploy so both sides place identically.");
    }
    return backendVersion;
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamMessage> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) yield JSON.parse(line) as StreamMessage;
        }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) yield JSON.parse(rest) as StreamMessage;
}

/**
 * Run makePcbLayout on the GPU host. The backend version is pinned on both
 * sides; aborting the signal closes the stream, which cancels the remote job.
 */
export async function makePcbLayoutRemote(
    endpoint: URL,
    input: MakePcbLayoutInput,
    options: RemoteLayoutOptions,
    env: NodeJS.ProcessEnv = process.env,
): Promise<LayoutResult> {
    const backendVersion = await checkService(endpoint, env, options.signal);
    const response = await fetchOrExplain(endpoint, "v1/make-pcb-layout", {
        method: "POST",
        headers: requestHeaders(env),
        body: JSON.stringify({ protocol: PROTOCOL, backendVersion, input, options: { edaEdition: options.edaEdition } }),
        signal: options.signal,
    });
    if (!response.ok || !response.body) {
        throw new Error(`Remote placement failed: HTTP ${response.status} ${await response.text()}`);
    }
    for await (const message of ndjson(response.body)) {
        if (message.type === "progress") options.onProgress(message.progress);
        else if (message.type === "result") return message.result;
        else if (message.type === "error") throw new Error(`Remote placement failed: ${message.message}`);
    }
    options.signal.throwIfAborted();
    throw new Error("Remote placement stream ended without a result.");
}
