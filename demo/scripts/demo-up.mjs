#!/usr/bin/env node
// The local private-search demo, in one command: Anvil, a vault deployed
// with the development setup, the indexer, `zkapi serverd` serving
// fixed-price direct requests from the demo search API, and the web page.
//
//   node demo/scripts/demo-up.mjs [--skip-build] [--fresh]
//
// Then open http://127.0.0.1:5173. Ctrl-C stops everything. Logs and state
// are in demo/.local/ (--fresh deletes them first). Development keys only:
// never point this at a chain with real funds.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL = path.join(ROOT, 'demo/.local');
const BIN = path.join(ROOT, 'target/demo/release');
const SETUP_DIR = path.join(ROOT, 'protocol/setup/v2-concession-dev');

const CHAIN_ID = 31337;
const PORTS = { anvil: 8545, server: 8787, indexer: 8788, search: 8090, web: 5173 };
const RPC_URL = `http://127.0.0.1:${PORTS.anvil}`;
// Anvil's first default account deploys and owns the vault.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// Whole gwei: a search costs 0.0001 ETH, and every request proves a balance of
// at least the cap, so a 0.01 ETH deposit pays for 99 searches.
const REQUEST_CHARGE_CAP = 100_000;
const PRICE_UNITS = 100_000;
// Never read in direct mode; the deployment profile requires a feed address.
const UNUSED_PRICE_FEED = '0x0000000000000000000000000000000000000001';

const args = new Set(process.argv.slice(2));
const children = [];

function log(message) {
    console.log(`\x1b[36m[demo]\x1b[0m ${message}`);
}

function fail(message) {
    console.error(`\x1b[31m[demo] ${message}\x1b[0m`);
    shutdown(1);
}

function run(command, commandArgs, { cwd = ROOT, env = {}, label = command } = {}) {
    log(`${label}…`);
    const result = spawnSync(command, commandArgs, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (result.status !== 0) {
        fail(`${label} failed (exit ${result.status}):\n${(result.stderr || result.stdout || '').slice(-4000)}`);
    }
    return result.stdout;
}

function launch(name, command, commandArgs, env = {}) {
    const logPath = path.join(LOCAL, `${name}.log`);
    const out = fs.openSync(logPath, 'a');
    const child = spawn(command, commandArgs, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
    child.on('exit', (code, signal) => {
        if (!shuttingDown) fail(`${name} exited (${signal ?? code}); see ${path.relative(ROOT, logPath)}`);
    });
    children.push(child);
    return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children.reverse()) child.kill('SIGTERM');
    process.exit(code);
}
process.on('SIGINT', () => { log('stopping'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

async function waitFor(label, probe, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const value = await probe();
            if (value) return value;
        } catch {
            // not up yet
        }
        if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

async function rpc(method, params = []) {
    const response = await fetch(RPC_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
}

async function getJSON(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
}

async function portFree(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        return false;
    } catch (error) {
        return error.cause?.code === 'ECONNREFUSED';
    }
}

// ------------------------------------------------------------------ prepare
if (args.has('--fresh')) fs.rmSync(LOCAL, { recursive: true, force: true });
fs.mkdirSync(LOCAL, { recursive: true });
for (const [name, port] of Object.entries(PORTS)) {
    if (!(await portFree(port))) fail(`port ${port} (${name}) is in use: stop whatever runs there first`);
}
for (const tool of ['anvil', 'forge', 'cargo']) {
    if (spawnSync(tool, ['--version']).status !== 0) fail(`${tool} is not installed`);
}

if (!args.has('--skip-build')) {
    // Daemons that accept the single-party dev setup the demo vault uses, in
    // their own target directory so they never replace a release build.
    run('cargo', ['build', '--release', '--target-dir', 'target/demo', '--features', 'zkapi-proof/dev-setup',
        '-p', 'zkapi-cli', '--bin', 'zkapi', '-p', 'zkapi-indexerd', '--bin', 'zkapi-indexerd'], { label: 'cargo build (dev setup)' });
    run('forge', ['build'], { cwd: path.join(ROOT, 'protocol/contracts'), label: 'forge build (protocol)' });
    run('forge', ['build'], { cwd: path.join(ROOT, 'demo/contracts'), label: 'forge build (deploy script)' });
}
const zkapi = path.join(BIN, 'zkapi');
for (const binary of [zkapi, path.join(BIN, 'zkapi-indexerd')]) {
    if (!fs.existsSync(binary)) fail(`${binary} is missing: run without --skip-build`);
}

// Fresh operator seeds per run; the keys they derive are pinned in the vault.
const seedEnv = {
    ZKAPI_STATE_SEED: `0x${randomBytes(31).toString('hex')}`,
    ZKAPI_CLEAR_SEED: `0x${randomBytes(31).toString('hex')}`,
};
const signingKeys = JSON.parse(run(zkapi, ['signing-keys'], { env: seedEnv, label: 'derive operator signing keys' }));

// ------------------------------------------------------------------ chain
launch('anvil', 'anvil', ['--host', '127.0.0.1', '--port', String(PORTS.anvil), '--chain-id', String(CHAIN_ID),
    '--block-time', '1', '--slots-in-an-epoch', '1']);
await waitFor('Anvil', async () => Number(await rpc('eth_chainId')) === CHAIN_ID);
log(`Anvil on ${RPC_URL} (chain ${CHAIN_ID})`);

// ------------------------------------------------------------------ deploy
// Deploy.s.sol may write only under .demo/ (demo/contracts/foundry.toml).
const deployDir = path.join(ROOT, '.demo/direct-search');
fs.rmSync(deployDir, { recursive: true, force: true });
fs.mkdirSync(deployDir, { recursive: true });
const pendingPath = path.join(deployDir, 'deployment.json.pending');
const finalizedPath = path.join(deployDir, 'deployment.json');
const broadcastDir = path.join(LOCAL, 'broadcast');
run('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', RPC_URL, '--broadcast'], {
    cwd: path.join(ROOT, 'demo/contracts'),
    label: 'deploy the vault (Deploy.s.sol)',
    env: {
        FOUNDRY_BROADCAST: broadcastDir, PRIVATE_KEY: DEPLOYER_KEY, CHAIN_ID: String(CHAIN_ID),
        OUTPUT_PATH: finalizedPath, SETUP_MANIFEST: path.join(SETUP_DIR, 'manifest.json'),
        STATE_SIGNING_KEY_X: signingKeys.state_signing_key.x, STATE_SIGNING_KEY_Y: signingKeys.state_signing_key.y,
        CLEARANCE_SIGNING_KEY_X: signingKeys.clearance_signing_key.x, CLEARANCE_SIGNING_KEY_Y: signingKeys.clearance_signing_key.y,
        REQUEST_CHARGE_CAP: String(REQUEST_CHARGE_CAP), GASLESS: '0',
    },
});
run(process.execPath, [path.join(ROOT, 'scripts/expected-codehashes.mjs'), '--deployment', pendingPath, '--rpc', RPC_URL,
    '--finalize', finalizedPath, '--broadcast-log', path.join(broadcastDir, 'Deploy.s.sol', String(CHAIN_ID), 'run-latest.json')],
{ label: 'finalize the deployment manifest' });
const finalized = JSON.parse(fs.readFileSync(finalizedPath, 'utf8'));
const vault = finalized.vault.toLowerCase();
log(`vault ${vault} (deploy block ${finalized.deployBlock})`);

const serverUrl = `http://127.0.0.1:${PORTS.server}`;
const indexerUrl = `http://127.0.0.1:${PORTS.indexer}`;
const profilePath = path.join(LOCAL, 'trusted-deployment.json');
run(process.execPath, [path.join(ROOT, 'scripts/deployment-profile.mjs'), '--finalized', finalizedPath,
    '--deployment-id', 'demo-direct-search-local', '--protocol-server-url', serverUrl, '--indexer-url', indexerUrl,
    '--rpc-url', RPC_URL, '--verifier-url', 'http://127.0.0.1:9', '--price-feed', UNUSED_PRICE_FEED,
    '--settlement-window-seconds', '60', '--out', profilePath], { label: 'write the deployment profile' });

// ------------------------------------------------------------------ daemons
launch('indexer', path.join(BIN, 'zkapi-indexerd'), ['--listen', `127.0.0.1:${PORTS.indexer}`, '--rpc-url', RPC_URL,
    '--contract-address', vault, '--from-block', String(finalized.deployBlock), '--poll-interval-ms', '500',
    '--chain-id', String(CHAIN_ID), '--confirmations', '0', '--max-head-age-secs', '0',
    '--cursor-path', path.join(LOCAL, 'indexer.json')]);
await waitFor('the indexer', () => getJSON(`${indexerUrl}/v1/tree/snapshot`));

const dbPath = path.join(LOCAL, 'server.db');
fs.rmSync(dbPath, { force: true });
run(zkapi, ['--proof-setup-dir', SETUP_DIR, 'db', 'init', '--deployment', profilePath, '--db', dbPath], { label: 'zkapi db init' });

launch('search-api', process.execPath, [path.join(ROOT, 'demo/search-api/server.mjs'), '--port', String(PORTS.search)]);
await waitFor('the search API', () => getJSON(`http://127.0.0.1:${PORTS.search}/health`));

launch('server', zkapi, ['--chain-id', String(CHAIN_ID), '--contract-address', vault,
    '--request-charge-cap', String(REQUEST_CHARGE_CAP), '--proof-setup-dir', SETUP_DIR, 'serverd',
    '--listen', `127.0.0.1:${PORTS.server}`, '--deployment', profilePath, '--native-billing-rpc-url', RPC_URL,
    '--direct-api-url', `http://127.0.0.1:${PORTS.search}/search`, '--direct-api-price-units', String(PRICE_UNITS),
    '--db-path', dbPath, '--indexer-url', indexerUrl, '--root-poll-interval-ms', '1000'], seedEnv);
await waitFor('serverd', async () => (await getJSON(`${serverUrl}/health`)).current_root, 90_000);

// ------------------------------------------------------------------ web
const web = {
    chain_id: CHAIN_ID,
    rpc_url: RPC_URL,
    contract_address: vault,
    deploy_block: finalized.deployBlock,
    request_charge_cap: REQUEST_CHARGE_CAP,
    price_units: PRICE_UNITS,
    min_deposit_units: finalized.minDeposit,
    state_signing_key: { x: signingKeys.state_signing_key.x, y: signingKeys.state_signing_key.y },
    clearance_signing_key: { x: signingKeys.clearance_signing_key.x, y: signingKeys.clearance_signing_key.y },
};
fs.writeFileSync(path.join(LOCAL, 'web-config.json'), `${JSON.stringify(web, null, 2)}\n`);
launch('web', process.execPath, [path.join(ROOT, 'demo/web/serve.mjs'), '--port', String(PORTS.web)], {
    DEMO_SERVER_URL: serverUrl, DEMO_INDEXER_URL: indexerUrl, DEMO_RPC_URL: RPC_URL,
});
await waitFor('the web page', () => fetch(`http://127.0.0.1:${PORTS.web}/`).then(response => response.ok));

log('ready');
console.log(`
  Web page      http://127.0.0.1:${PORTS.web}
  Server        ${serverUrl}   (POST /v2/requests, ${PRICE_UNITS} gwei per search)
  Indexer       ${indexerUrl}
  Search API    http://127.0.0.1:${PORTS.search}/search
  Anvil         ${RPC_URL}  (chain ${CHAIN_ID})
  Vault         ${vault}
  Logs          demo/.local/*.log

  Ctrl-C stops everything.
`);
