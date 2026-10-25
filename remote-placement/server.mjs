// Remote PCB placement service for a CUDA/Vulkan host.
//
// Runs eda-copilot-backend's makePcbLayout next to the GPU and streams its
// progress back as NDJSON. It binds to loopback only: clients reach it through
// an SSH local forward, so the port is never exposed on the network.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { makePcbLayout, disposeBackend } from 'eda-copilot-backend/pcb';

const PROTOCOL = 1;
const require = createRequire(import.meta.url);
const backendVersion = require('eda-copilot-backend/package.json').version;
const host = process.env.EASYEDA_PLACEMENT_HOST || '127.0.0.1';
const port = Number(process.env.EASYEDA_PLACEMENT_PORT || 18787);
const token = process.env.EASYEDA_PLACEMENT_TOKEN || '';
const maxBodyBytes = Number(process.env.EASYEDA_PLACEMENT_MAX_BODY_MB || 512) * 1024 * 1024;
// SSH forwards and proxies drop idle streams; a silent solver stage can be long.
const heartbeatMs = 15_000;
let active = 0;

const log = (message, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));

function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) throw Object.assign(new Error(`Request body exceeds ${maxBodyBytes} bytes.`), { status: 413 });
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleLayout(req, res) {
    const body = await readJson(req);
    if (body.protocol !== PROTOCOL) {
        return sendJson(res, 400, { error: `Unsupported placement protocol ${body.protocol}; this service speaks ${PROTOCOL}.` });
    }
    if (body.backendVersion !== backendVersion) {
        return sendJson(res, 409, { error: `Client eda-copilot-backend ${body.backendVersion} does not match service ${backendVersion}.` });
    }

    const controller = new AbortController();
    res.on('close', () => {
        if (!res.writableFinished) controller.abort(new Error('Placement client disconnected.'));
    });
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const send = message => { if (!res.writableEnded) res.write(JSON.stringify(message) + '\n'); };
    const heartbeat = setInterval(() => send({ type: 'heartbeat' }), heartbeatMs);
    const started = Date.now();
    const components = body.input?.circuit?.components?.length ?? 0;
    active++;
    log('placement started', { components, active });
    try {
        const result = await makePcbLayout(body.input, {
            edaEdition: body.options?.edaEdition,
            signal: controller.signal,
            onProgress: progress => send({ type: 'progress', progress }),
        });
        send({ type: 'result', result, elapsedMs: Date.now() - started });
        log('placement finished', { components, elapsedMs: Date.now() - started });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted) log('placement cancelled', { components, elapsedMs: Date.now() - started });
        else {
            send({ type: 'error', message });
            log('placement failed', { components, message });
        }
    } finally {
        clearInterval(heartbeat);
        active--;
        res.end();
    }
}

const server = createServer(async (req, res) => {
    try {
        if (token && req.headers.authorization !== `Bearer ${token}`) return sendJson(res, 401, { error: 'Unauthorized.' });
        const path = new URL(req.url ?? '/', 'http://placement').pathname;
        if (req.method === 'GET' && path === '/health') {
            return sendJson(res, 200, {
                ok: true,
                service: 'easyeda-copilot-placement',
                protocol: PROTOCOL,
                backendVersion,
                node: process.version,
                platform: `${process.platform}-${process.arch}`,
                gpuRuntime: process.env.PCB_GPU_RUNTIME || 'auto',
                active,
            });
        }
        if (req.method === 'POST' && path === '/v1/make-pcb-layout') return await handleLayout(req, res);
        sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
        if (res.headersSent) return res.end();
        sendJson(res, error.status ?? 400, { error: error instanceof Error ? error.message : String(error) });
    }
});
server.requestTimeout = 0;

async function shutdown(signal) {
    log('shutting down', { signal });
    server.close();
    await disposeBackend();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, host, () => log('placement service listening', {
    host, port, backendVersion, gpuRuntime: process.env.PCB_GPU_RUNTIME || 'auto',
}));
