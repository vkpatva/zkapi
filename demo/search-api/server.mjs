#!/usr/bin/env node
// The demo operator's own API for direct requests: a small full-text search
// over a fixed document set. `zkapi serverd --direct-api-url
// http://127.0.0.1:8090/search` POSTs each admitted request's payload here
// and returns this server's JSON body to the client, after charging the fixed
// price. It never sees who asked: only the query.
//
// Request:  {"query": "nullifier", "limit": 3}
// Response: {"query": ..., "total": n, "results": [{"id", "title", "snippet", "score"}]}
//
// Usage: node demo/search-api/server.mjs [--port 8090] [--data path/to/docs.json]
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_LIMIT = 20;

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(option('port', process.env.SEARCH_API_PORT ?? '8090'));
const dataPath = option('data', fileURLToPath(new URL('./documents.json', import.meta.url)));
const documents = JSON.parse(readFileSync(dataPath, 'utf8'));

const tokens = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const index = documents.map((document) => ({
    document,
    terms: tokens(`${document.title} ${document.title} ${document.body}`),
}));

/** Term-frequency score of every document containing at least one query term. */
export function search(query, limit) {
    const wanted = [...new Set(tokens(query))];
    const results = [];
    for (const { document, terms } of index) {
        const score = wanted.reduce((sum, term) => sum + terms.filter((t) => t === term).length, 0);
        if (score > 0) {
            results.push({
                id: document.id,
                title: document.title,
                snippet: document.body.slice(0, 160),
                score,
            });
        }
    }
    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { query, total: results.length, results: results.slice(0, limit) };
}

function reply(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
    });
    response.end(text);
}

const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
        return reply(response, 200, { ok: true, documents: documents.length });
    }
    if (request.method !== 'POST' || request.url !== '/search') {
        return reply(response, 404, { error: 'not_found' });
    }
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            reply(response, 413, { error: 'body_too_large' });
            request.destroy();
        } else {
            chunks.push(chunk);
        }
    });
    request.on('end', () => {
        if (response.writableEnded) return;
        let payload;
        try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            return reply(response, 400, { error: 'invalid_json' });
        }
        const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
        if (!query || query.length > 256) {
            return reply(response, 400, { error: 'query must be a non-empty string of at most 256 characters' });
        }
        const limit = Number.isInteger(payload.limit) ? Math.min(Math.max(payload.limit, 1), MAX_LIMIT) : 5;
        reply(response, 200, search(query, limit));
    });
});

if (import.meta.url === `file://${process.argv[1]}`) {
    server.listen(port, '127.0.0.1', () => {
        console.log(`search API: ${documents.length} documents on http://127.0.0.1:${port}/search`);
    });
}
