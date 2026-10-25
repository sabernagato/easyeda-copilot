import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import type { MakePcbLayoutInput, PcbLayoutProgress } from 'eda-copilot-backend/pcb';
import { makePcbLayoutRemote, remotePlacementEndpoint } from '../src/tools/pcb/remote-placement';

const backendVersion: string = createRequire(import.meta.url)('eda-copilot-backend/package.json').version;
const input = { code: 'board.rect(10, 10);', circuit: { components: [] } } as unknown as MakePcbLayoutInput;

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function service(t: test.TestContext, layout: Handler, health: object = {}) {
    const requests: { path: string; body: string; authorization?: string }[] = [];
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ path: req.url ?? '', body, authorization: req.headers.authorization });
        if (req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, protocol: 1, backendVersion, ...health }));
        } else layout(req, res, body);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const { port } = server.address() as { port: number };
    return { endpoint: new URL(`http://127.0.0.1:${port}/`), requests };
}

const stream = (res: ServerResponse, ...messages: object[]) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const message of messages) res.write(JSON.stringify(message) + '\n');
    res.end();
};

test('the endpoint is opt-in and keeps a configured base path', () => {
    assert.equal(remotePlacementEndpoint({}), undefined);
    assert.equal(remotePlacementEndpoint({ EASYEDA_COPILOT_PLACEMENT_URL: '  ' }), undefined);
    assert.equal(remotePlacementEndpoint({ EASYEDA_COPILOT_PLACEMENT_URL: 'http://127.0.0.1:18787' })?.href, 'http://127.0.0.1:18787/');
    assert.equal(remotePlacementEndpoint({ EASYEDA_COPILOT_PLACEMENT_URL: 'https://gpu.example/placement' })?.href, 'https://gpu.example/placement/');
});

test('progress is forwarded and the streamed result is returned', async t => {
    const result = { content: 'placed', pcb: { components: [] } };
    const { endpoint, requests } = await service(t, (_req, res) => stream(res,
        { type: 'progress', progress: { stage: 'parse_dsl', progress: 5, content: 'Parsing' } },
        { type: 'heartbeat' },
        { type: 'progress', progress: { stage: 'done', progress: 100, content: 'Done' } },
        { type: 'result', result, elapsedMs: 12 },
    ));
    const progress: PcbLayoutProgress[] = [];
    const placed = await makePcbLayoutRemote(endpoint, input, {
        edaEdition: 'jlceda', signal: new AbortController().signal, onProgress: item => progress.push(item),
    }, { EASYEDA_COPILOT_PLACEMENT_TOKEN: 'secret' });
    assert.deepEqual(placed, result);
    assert.deepEqual(progress.map(item => item.stage), ['parse_dsl', 'done']);
    const request = JSON.parse(requests[1].body);
    assert.equal(requests[1].path, '/v1/make-pcb-layout');
    assert.equal(requests[1].authorization, 'Bearer secret');
    assert.deepEqual(request, { protocol: 1, backendVersion, input, options: { edaEdition: 'jlceda' } });
});

test('a backend version mismatch is refused before any job is sent', async t => {
    const { endpoint, requests } = await service(t, () => assert.fail('layout must not be requested'), { backendVersion: '0.0.0' });
    await assert.rejects(
        makePcbLayoutRemote(endpoint, input, { signal: new AbortController().signal, onProgress: () => {} }, {}),
        /runs eda-copilot-backend 0\.0\.0, but this MCP uses/,
    );
    assert.deepEqual(requests.map(item => item.path), ['/health']);
});

test('remote errors and truncated streams are failures', async t => {
    const failing = await service(t, (_req, res) => stream(res, { type: 'error', message: 'solver exploded' }));
    await assert.rejects(
        makePcbLayoutRemote(failing.endpoint, input, { signal: new AbortController().signal, onProgress: () => {} }, {}),
        /Remote placement failed: solver exploded/,
    );
    const truncated = await service(t, (_req, res) => stream(res, { type: 'progress', progress: { stage: 'solve_board' } }));
    await assert.rejects(
        makePcbLayoutRemote(truncated.endpoint, input, { signal: new AbortController().signal, onProgress: () => {} }, {}),
        /ended without a result/,
    );
});

test('an unreachable service names the tunnel helper', async () => {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as { port: number };
    await new Promise(resolve => probe.close(resolve));
    await assert.rejects(
        makePcbLayoutRemote(new URL(`http://127.0.0.1:${port}/`), input, { signal: new AbortController().signal, onProgress: () => {} }, {}),
        /Cannot reach the remote placement service .*remote-placement\.sh up/,
    );
});

test('aborting closes the stream so the remote job is cancelled', async t => {
    let serverSawClose!: () => void;
    const closed = new Promise<void>(resolve => { serverSawClose = resolve; });
    const controller = new AbortController();
    const { endpoint } = await service(t, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ type: 'progress', progress: { stage: 'solve_board' } }) + '\n');
        res.on('close', () => serverSawClose());
    });
    const pending = makePcbLayoutRemote(endpoint, input, {
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('operation cancelled')),
    }, {});
    await assert.rejects(pending, /operation cancelled/);
    await closed;
});
