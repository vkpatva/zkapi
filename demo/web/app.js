// The private-search demo page: deposit into the vault, then pay for each
// search with a request proof made in this browser (worker.js). The note's
// secret and state stay in this browser's localStorage.
//
// Flow of one search:
//   indexer snapshot -> Merkle path -> proof (worker) -> POST /v2/requests
//   -> the server's signed successor -> checked and installed (worker).

import {
    ABI, decodeNoteRecord, decodePendingWithdrawals, encodeEffectiveExpiry, encodeFinalizeEscape, encodeNoteRecord,
    encodePendingWithdrawals, encodeWithdrawal,
} from '/sdk/wallet.js';

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
const nowSeconds = () => Math.floor(Date.now() / 1000);
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const chainNow = async () => Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
let chainOffset = 0; // chain time minus wall time, refreshed by the operator view

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
    const exit = wallet?.exit;
    $('deposit').disabled = !account || (Boolean(state) && !exit?.done);
    $('search').disabled = !state || Boolean(wallet?.pending) || Boolean(exit);
    $('retry').hidden = !wallet?.pending;
    const canExit = Boolean(account && state && !wallet?.pending && !exit);
    $('mutual').disabled = !canExit;
    $('escape').disabled = !canExit;
    $('escape-status').hidden = !(exit?.mode === 'escape' && !exit.done);
    $('exit-result').textContent = exit?.done
        ? `Note #${state.note_id} closed by ${exit.mode === 'mutual' ? 'mutual close' : 'escape'}: you received ${eth(exit.paid)}, `
          + `the operator ${eth(BigInt(state.deposit_amount) - BigInt(exit.paid))}. Deposit again to start a new note.`
        : '';
    if (exit?.done) $('note-info').textContent = `Note #${state.note_id} · closed`;
    tickEscape();
}

function tickEscape() {
    const exit = load()?.exit;
    if (exit?.mode !== 'escape' || exit.done) return;
    const left = exit.deadline - (nowSeconds() + chainOffset);
    $('escape-text').textContent = left > 0
        ? `Escape pending: ${eth(exit.paid)} to ${exit.destination}. Finalizable in ${left} s (chain time); the operator can contest it until then.`
        : `The challenge period is over: finalize to receive ${eth(exit.paid)}.`;
    $('finalize').disabled = left > 0 || !account;
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

// ------------------------------------------------------------------ withdraw
function destination() {
    const value = $('destination').value.trim() || account;
    if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? '')) throw new Error('Enter a destination address (or connect a wallet).');
    return value.toLowerCase();
}

async function sendAndWait(tx, label) {
    const hash = await sendTransaction(tx);
    log(`${label} sent ${hash}`);
    const mined = await receipt(hash);
    if (mined.status !== '0x1') throw new Error(`${label} reverted`);
    return hash;
}

/** The proofs' validity: the vault compares it with chain time, which the demo may skip ahead. */
async function exitValidUntil() {
    return Math.max(nowSeconds(), await chainNow()) + 900;
}

async function mutualClose() {
    const wallet = load();
    const to = destination();
    const config = JSON.stringify(walletConfig);
    const state = JSON.stringify(wallet.state);
    log('proving note ownership for the operator\'s clearance…');
    const ownership = JSON.parse(await prover('prepareWithdrawal', {
        config, state, args: JSON.stringify({ mode: 'ownership', valid_until: nowSeconds() + 600 }),
    }));
    const response = await fetch('/api/server/v2/withdraw/clearance', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            withdrawal_nullifier: ownership.public_inputs.withdrawal_nullifier,
            ownership_proof: { public_inputs: ownership.public_inputs, proof: ownership.proof },
        }),
    });
    const clearance = await response.json();
    if (!response.ok) throw new Error(`${clearance.error_code}: ${clearance.error_message}`);
    log('the operator signed the clearance for this balance', 'ok');
    const plan = JSON.parse(await prover('prepareWithdrawal', {
        config, state, args: JSON.stringify({ mode: 'mutual', destination: to, valid_until: await exitValidUntil(), clearance }),
    }));
    const data = encodeWithdrawal(plan, 'mutual', to, demo.contract_address);
    const hash = await sendAndWait({ from: account, to: demo.contract_address, data, gas: '0x2dc6c0' }, 'mutual close');
    const paid = String(BigInt(plan.public_inputs.final_balance));
    save({ ...wallet, exit: { mode: 'mutual', done: true, tx: hash, paid, destination: to } });
    log(`closed: ${eth(paid)} paid to ${to}`, 'ok');
    await refreshOperator();
}

async function escape() {
    const wallet = load();
    const to = destination();
    log('proving the latest signed balance for an escape (no operator involved)…');
    const plan = JSON.parse(await prover('prepareWithdrawal', {
        config: JSON.stringify(walletConfig), state: JSON.stringify(wallet.state),
        args: JSON.stringify({ mode: 'escape', destination: to, conceded: 0, valid_until: await exitValidUntil() }),
    }));
    const data = encodeWithdrawal(plan, 'escape', to, demo.contract_address, { conceded: 0 });
    const hash = await sendAndWait({ from: account, to: demo.contract_address, data, gas: '0x2dc6c0' }, 'escape');
    const pendingEscape = decodePendingWithdrawals(
        await ethCall(demo.contract_address, encodePendingWithdrawals(wallet.state.note_id)));
    save({ ...wallet, exit: { mode: 'escape', done: false, tx: hash, destination: to,
        paid: String(pendingEscape.finalBalance), deadline: Number(pendingEscape.challengeDeadline) } });
    log(`escape started; finalizable after ${demo.challenge_period} s`, 'ok');
    await refreshOperator();
}

async function finalizeEscape() {
    const wallet = load();
    await sendAndWait({ from: account, to: demo.contract_address, data: encodeFinalizeEscape(wallet.state.note_id),
        gas: '0x7a120' }, 'finalize escape');
    save({ ...wallet, exit: { ...wallet.exit, done: true } });
    log(`escape finalized: ${eth(wallet.exit.paid)} paid to ${wallet.exit.destination}`, 'ok');
    await refreshOperator();
}

// ------------------------------------------------------------------ operator view
const STATUS = ['—', 'active', 'escaping', 'closed'];
let claimableNotes = [];

async function operatorSend(data, label) {
    // Anvil account 0 deployed and owns the vault; any account could send these.
    const [operator] = await rpc('eth_accounts');
    const hash = await rpc('eth_sendTransaction', [{ from: operator, to: demo.contract_address, data, gas: '0x7a120' }]);
    const mined = await receipt(hash);
    if (mined.status !== '0x1') throw new Error(`${label} reverted`);
    log(`${label} (${hash})`, 'ok');
}

async function refreshOperator() {
    const [treasury, vaultBalance, now] = await Promise.all([
        rpc('eth_getBalance', [demo.treasury, 'latest']),
        rpc('eth_getBalance', [demo.contract_address, 'latest']),
        chainNow(),
    ]);
    chainOffset = now - nowSeconds();
    $('treasury-balance').textContent = `${(Number(BigInt(treasury) / GWEI) / 1e9).toFixed(4)} ETH`;
    $('vault-balance').textContent = `${(Number(BigInt(vaultBalance) / GWEI) / 1e9).toFixed(4)} ETH`;
    $('chain-time').textContent = `${new Date(now * 1000).toLocaleString()}${chainOffset > 60 ? ` (+${Math.round(chainOffset / 60)} min)` : ''}`;
    const logs = await rpc('eth_getLogs', [{ address: demo.contract_address, fromBlock: `0x${demo.deploy_block.toString(16)}`,
        toBlock: 'latest', topics: [NOTE_DEPOSITED_TOPIC] }]);
    claimableNotes = [];
    const rows = [];
    for (const entry of logs) {
        const note = {
            id: Number(BigInt(entry.topics[1])),
            commitment: entry.topics[2],
            amount: BigInt(`0x${entry.data.slice(2, 66)}`),
            expiry: BigInt(`0x${entry.data.slice(66, 130)}`),
        };
        const record = decodeNoteRecord(await ethCall(demo.contract_address, encodeNoteRecord(note.id)));
        const claimableAt = Number(BigInt(await ethCall(demo.contract_address,
            encodeEffectiveExpiry(note.id, note.commitment, note.amount, note.expiry))));
        const row = document.createElement('tr');
        const cells = [`#${note.id}`, eth(note.amount), STATUS[record.status],
            claimableAt ? new Date(claimableAt * 1000).toLocaleString() : '—'];
        for (const text of cells) {
            const cell = document.createElement('td');
            cell.textContent = text;
            row.append(cell);
        }
        const action = document.createElement('td');
        if (record.status === 1) {
            claimableNotes.push(claimableAt);
            const button = document.createElement('button');
            button.textContent = now >= claimableAt ? 'Claim expired' : 'Not expired';
            button.disabled = now < claimableAt;
            button.onclick = guarded(button, async () => {
                const data = `0x${ABI.claimExpired}${word(note.id)}${word(note.commitment)}${word(note.amount)}${word(note.expiry)}`;
                await operatorSend(data, `claimExpired(#${note.id}): ${eth(note.amount)} to the treasury`);
                await refreshOperator();
            });
            action.append(button);
        }
        row.append(action);
        rows.push(row);
    }
    $('notes').replaceChildren(...rows.reverse());
    render();
}

async function skipTime(seconds, label) {
    await rpc('evm_increaseTime', [seconds]);
    await rpc('evm_mine', []);
    log(`skipped chain time ${label}`);
    await refreshOperator();
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
    $('mutual').onclick = guarded($('mutual'), mutualClose);
    $('escape').onclick = guarded($('escape'), escape);
    $('finalize').onclick = guarded($('finalize'), finalizeEscape);
    $('refresh-notes').onclick = guarded($('refresh-notes'), refreshOperator);
    $('skip-hour').onclick = guarded($('skip-hour'), () => skipTime(3_600, '+1 h'));
    $('skip-expiry').onclick = guarded($('skip-expiry'), async () => {
        const now = await chainNow();
        const next = claimableNotes.filter(at => at > now).sort((a, b) => a - b)[0];
        if (!next) throw new Error('No active note is waiting to expire.');
        await skipTime(next - now + 5, `to ${new Date((next + 5) * 1000).toLocaleString()}`);
    });
    $('reset').onclick = () => {
        if (confirm('Forget this note? Its secret is only in this browser: the deposit becomes unspendable from here.')) {
            localStorage.removeItem(storageKey);
            render();
            log('note forgotten');
        }
    };
    render();
    setInterval(tickEscape, 1_000);
    setInterval(() => refreshOperator().catch(() => {}), 5_000);
    refreshOperator().catch(error => log(error.message, 'err'));
    log(`prover loaded (setup ${await prover('setupId')}), vault ${demo.contract_address}`);
}

main().catch(error => log(error.message, 'err'));
