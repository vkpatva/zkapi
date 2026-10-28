#!/usr/bin/env node
// Serves the demo page and proxies the operator's services under one origin,
// so the page needs no CORS from serverd or the indexer:
//
//   /api/server/*   -> DEMO_SERVER_URL   (zkapi serverd)
//   /api/indexer/*  -> DEMO_INDEXER_URL  (zkapi-indexerd)
//   /rpc            -> DEMO_RPC_URL      (Anvil; JSON-RPC POST only)
//   /wasm/*, /proofs/request.pk          the browser prover from sdk/
//   /config.json                         demo/.local/web-config.json
//
// Usage: node demo/web/serve.mjs [--port 5173]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = path.join(ROOT, 'demo/web');
const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex > 0 ? process.argv[portIndex + 1] : 5173);
const upstreams = {
    '/api/server/': process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:8787',
    '/api/indexer/': process.env.DEMO_INDEXER_URL ?? 'http://127.0.0.1:8788',
};
const rpcUrl = process.env.DEMO_RPC_URL ?? 'http://127.0.0.1:8545';

const files = {
    '/': path.join(WEB, 'index.html'),
    '/app.js': path.join(WEB, 'app.js'),
    '/worker.js': path.join(WEB, 'worker.js'),
    '/style.css': path.join(WEB, 'style.css'),
    '/config.json': path.join(ROOT, 'demo/.local/web-config.json'),
    '/wasm/zkapi_browser.js': path.join(ROOT, 'sdk/wasm/zkapi_browser.js'),
    '/wasm/zkapi_browser_bg.wasm': path.join(ROOT, 'sdk/wasm/zkapi_browser_bg.wasm'),
    '/proofs/request.pk': path.join(ROOT, 'sdk/assets/proofs/request.pk'),
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.pk': 'application/octet-stream' };

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

async function proxy(request, response, target) {
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readBody(request);
    try {
        const upstream = await fetch(target, {
            method: request.method,
            headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
            body,
            signal: AbortSignal.timeout(120_000),
        });
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error_code: 'proxy_failed', error_message: String(error.cause?.code ?? error.message) }));
    }
}

http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    for (const [prefix, base] of Object.entries(upstreams)) {
        if (url.pathname.startsWith(prefix)) {
            return proxy(request, response, `${base}/${url.pathname.slice(prefix.length)}${url.search}`);
        }
    }
    if (url.pathname === '/rpc' && request.method === 'POST') return proxy(request, response, rpcUrl);
    const file = files[url.pathname];
    if (!file || !fs.existsSync(file)) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        return response.end('not found');
    }
    response.writeHead(200, { 'content-type': types[path.extname(file)] ?? types['.html'], 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`demo web page on http://127.0.0.1:${port}`));
