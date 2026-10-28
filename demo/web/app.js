// The private-search demo page: deposit into the vault, then pay for each
// search with a request proof made in this browser (worker.js). The note's
// secret and state stay in this browser's localStorage.
//
// Flow of one search:
//   indexer snapshot -> Merkle path -> proof (worker) -> POST /v2/requests
//   -> the server's signed successor -> checked and installed (worker).

const $ = id => document.getElementById(id);
const DEPOSIT_SELECTOR = '0x56d2e1ea'; // deposit(bytes32,uint128)
const NOTE_DEPOSITED_TOPIC = '0x3d5756e39e88718c2260db175f4f454d73fbd02468313b9406bf5c0733481c36';
const GWEI = 1_000_000_000n;

let demo;           // /config.json, written by demo-up.mjs
let walletConfig;   // BrowserWalletConfig for the prover
let account = null;
let storageKey;

// ------------------------------------------------------------------ worker
const worker = new Worker('/worker.js', { type: 'module' });
const pending = new Map();
let nextId = 0;
worker.onmessage = ({ data: { id, result, error } }) => {
    const { resolve, reject } = pending.get(id);
    pending.delete(id);
    error ? reject(new Error(error)) : resolve(result);
};
const prover = (call, args) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, call, args });
});

// ------------------------------------------------------------------ helpers
function log(message, kind = '') {
    const item = document.createElement('li');
    item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    if (kind) item.className = kind;
    $('log').prepend(item);
}

async function rpc(method, params = []) {
    const response = await fetch('/rpc', {
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const eth = gwei => `${(Number(gwei) / 1e9).toFixed(4)} ETH`;
const word = value => BigInt(value).toString(16).padStart(64, '0');

function load() {
    try {
        return JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    } catch {
        return null;
    }
}

function save(wallet) {
    localStorage.setItem(storageKey, JSON.stringify(wallet));
    render();
}

function render() {
    const wallet = load();
    const state = wallet?.state;
    $('balance').textContent = state ? eth(state.current_balance) : '—';
    $('note-info').textContent = state
        ? `Note #${state.note_id} · deposited ${eth(state.deposit_amount)} · ${state.is_genesis ? 'unspent' : 'spent from'}`
        : 'No note yet';
    $('price').textContent = `Each search costs ${eth(demo.price_units)}; a search needs a balance of at least ${eth(demo.request_charge_cap)}.`;
    $('deposit').disabled = !account || Boolean(state);
    $('search').disabled = !state || Boolean(wallet?.pending);
    $('retry').hidden = !wallet?.pending;
}

// ------------------------------------------------------------------ wallet
async function connect() {
    const mode = $('wallet-mode').value;
    if (mode === 'injected') {
        if (!window.ethereum) throw new Error('No browser wallet found. Choose the Anvil test account instead.');
        [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }));
        if (chainId !== demo.chain_id) {
            throw new Error(`Switch the wallet to the local Anvil network (chain ${demo.chain_id}, RPC ${demo.rpc_url}).`);
        }
    } else {
        // Anvil's default accounts are unlocked: account 1 (account 0 deployed the vault).
        account = (await rpc('eth_accounts'))[1];
    }
    const balance = BigInt(await rpc('eth_getBalance', [account, 'latest']));
    $('account').textContent = `${account} · ${(Number(balance / GWEI) / 1e9).toFixed(3)} ETH on chain`;
    log(`connected ${account}`, 'ok');
    render();
}

async function sendTransaction(tx) {
    if ($('wallet-mode').value === 'injected') {
        return window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
    }
    return rpc('eth_sendTransaction', [tx]);
}

async function receipt(hash) {
    for (let i = 0; i < 120; i++) {
        const found = await rpc('eth_getTransactionReceipt', [hash]);
        if (found) return found;
        await sleep(500);
    }
    throw new Error(`no receipt for ${hash}`);
}

// ------------------------------------------------------------------ deposit
async function deposit() {
    const units = BigInt(Math.round(Number($('deposit-eth').value) * 1e9));
    if (units < BigInt(demo.min_deposit_units)) throw new Error(`The minimum deposit is ${eth(demo.min_deposit_units)}.`);
    const params = JSON.parse(await prover('generateDeposit'));
    log('generated a note secret in this browser');
    const data = DEPOSIT_SELECTOR + word(params.registration_commitment) + word(units);
    const hash = await sendTransaction({
        from: account, to: demo.contract_address, data,
        value: `0x${(units * GWEI).toString(16)}`, gas: '0xf4240',
    });
    log(`deposit sent ${hash}`);
    const mined = await receipt(hash);
    if (mined.status !== '0x1') throw new Error('the deposit reverted');
    const event = mined.logs.find(entry => entry.topics[0] === NOTE_DEPOSITED_TOPIC
        && entry.address.toLowerCase() === demo.contract_address);
    const noteId = Number(BigInt(event.topics[1]));
    const amount = Number(BigInt(`0x${event.data.slice(2, 66)}`));
    const expiryTs = Number(BigInt(`0x${event.data.slice(66, 130)}`));
    const state = await prover('confirmDeposit', {
        config: JSON.stringify(walletConfig),
        args: JSON.stringify({ secret: params.secret, note_id: noteId, amount, expiry_ts: expiryTs }),
    });
    save({ state: JSON.parse(state), pending: null });
    log(`note #${noteId} deposited: ${eth(amount)}`, 'ok');
}

// ------------------------------------------------------------------ search
/** A tree snapshot containing our note, at the root serverd admits now. */
async function admittedSnapshot(noteId) {
    for (let i = 0; i < 60; i++) {
        const snapshot = await getJSON('/api/indexer/v1/tree/snapshot');
        const health = await getJSON('/api/server/health');
        if (snapshot.next_note_id > noteId && BigInt(health.current_root) === BigInt(snapshot.root)) return snapshot;
        await sleep(500);
    }
    throw new Error('the indexer and the server did not agree on a root containing the note');
}

async function search(query) {
    const wallet = load();
    if (BigInt(wallet.state.current_balance) < BigInt(demo.request_charge_cap)) {
        throw new Error('The balance is below the per-request bound; deposit a new note.');
    }
    const started = performance.now();
    const snapshot = await admittedSnapshot(wallet.state.note_id);
    const path = JSON.parse(await prover('treePath', { snapshot: JSON.stringify(snapshot), noteId: wallet.state.note_id }));
    log(`proving membership in a tree of ${snapshot.next_note_id} notes…`);
    const prepared = JSON.parse(await prover('prepareRequest', {
        config: JSON.stringify(walletConfig),
        state: JSON.stringify(wallet.state),
        args: JSON.stringify({
            payload: JSON.stringify({ query, limit: 5 }),
            active_root: path.active_root,
            merkle_siblings: path.siblings,
            client_request_id: crypto.randomUUID(),
            request_time: Math.floor(Date.now() / 1000),
            created_at_ms: Date.now(),
        }),
    }));
    log(`proof ready in ${((performance.now() - started) / 1000).toFixed(1)} s; nullifier ${prepared.request.public_inputs.request_nullifier.slice(0, 18)}…`);
    // Commit the prepared state and the request before it leaves the browser,
    // so a lost response can be fetched again by resending it.
    save({ state: prepared.state, pending: { request: prepared.request, journal: prepared.journal } });
    await send();
}

async function send() {
    const wallet = load();
    const { request, journal } = wallet.pending;
    const response = await fetch('/api/server/v2/requests', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    const body = await response.json();
    if (!response.ok) {
        const retriable = body.retriable;
        throw new Error(`${body.error_code}: ${body.error_message}${retriable ? ' (press "Resend")' : ''}`);
    }
    const next = await prover('completeResponse', {
        config: JSON.stringify(walletConfig),
        args: JSON.stringify({ state: wallet.state, journal, response: body }),
    });
    save({ state: JSON.parse(next), pending: null });
    log(`paid ${eth(body.charge_applied)}; the server's signature on the new balance verified`, 'ok');
    showResults(JSON.parse(body.response_payload));
}

function showResults(result) {
    const list = $('results');
    list.replaceChildren();
    if (!result.results?.length) {
        list.textContent = `No results for "${result.query}".`;
        return;
    }
    for (const hit of result.results) {
        const item = document.createElement('li');
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = hit.title;
        const snippet = document.createElement('div');
        snippet.className = 'snippet';
        snippet.textContent = hit.snippet;
        item.append(title, snippet);
        list.append(item);
    }
}

// ------------------------------------------------------------------ wiring
function guarded(button, action) {
    return async event => {
        event?.preventDefault();
        button.disabled = true;
        try {
            await action();
        } catch (error) {
            log(error.message, 'err');
        } finally {
            render();
        }
    };
}

async function main() {
    demo = await getJSON('/config.json');
    storageKey = `zkapi-demo:${demo.chain_id}:${demo.contract_address}`;
    walletConfig = {
        protocol_version: 2,
        chain_id: demo.chain_id,
        contract_address: demo.contract_address,
        request_charge_cap: demo.request_charge_cap,
        policy_charge_cap: demo.request_charge_cap,
        policy_enabled: false,
        state_signing_key: demo.state_signing_key,
        clearance_signing_key: demo.clearance_signing_key,
    };
    $('connect').onclick = guarded($('connect'), connect);
    $('deposit').onclick = guarded($('deposit'), deposit);
    $('search-form').onsubmit = guarded($('search'), async () => {
        const query = $('query').value.trim();
        if (query) await search(query);
    });
    $('retry').onclick = guarded($('retry'), send);
    $('reset').onclick = () => {
        if (confirm('Forget this note? Its secret is only in this browser: the deposit becomes unspendable from here.')) {
            localStorage.removeItem(storageKey);
            render();
            log('note forgotten');
        }
    };
    render();
    log(`prover loaded (setup ${await prover('setupId')}), vault ${demo.contract_address}`);
}

main().catch(error => log(error.message, 'err'));
