// The private-search demo page: deposit into the vault (each deposit is its
// own note), then pay for each search with a request proof made in this
// browser (worker.js) from the note chosen under "Pay with". Every note's
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
let walletPrefix;   // storage key of this vault's wallets; one per account

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

// Wallet storage: { notes: { [noteId]: { state, pending, exit } } }. A note's
// `state` is the prover's BrowserNoteState, `pending` a prepared request not
// yet answered, `exit` its withdrawal. The single-note layout of earlier
// builds ({ state, pending, exit }) is migrated on load.
// Each connected address keeps its own notes, so several addresses act as
// separate users. (A note is a bearer secret: nothing on chain ties it to
// the address that deposited it.)
const storageKey = () => (account ? `${walletPrefix}:${account.toLowerCase()}` : null);

function load() {
    if (!account) return { notes: {} };
    let wallet;
    try {
        wallet = JSON.parse(localStorage.getItem(storageKey()) ?? 'null');
    } catch {
        wallet = null;
    }
    if (wallet?.state) wallet = { notes: { [wallet.state.note_id]: { state: wallet.state, pending: wallet.pending, exit: wallet.exit } } };
    return wallet?.notes ? wallet : { notes: {} };
}

function save(wallet) {
    if (!account) throw new Error('Connect an account first.');
    localStorage.setItem(storageKey(), JSON.stringify(wallet));
    render();
}

function updateNote(noteId, patch) {
    const wallet = load();
    wallet.notes[noteId] = { ...wallet.notes[noteId], ...patch };
    save(wallet);
}

const myNotes = () => Object.values(load().notes).sort((a, b) => a.state.note_id - b.state.note_id);
// The vault's status of each note, from the operator view's refresh (1 active,
// 2 escaping, 3 closed); a closed note this browser did not exit was swept.
const chainStatus = new Map();
const isOpen = note => !note.exit && chainStatus.get(note.state.note_id) !== 3;
// A request proves expiry >= request time, so an expired note can only withdraw.
const canPay = note => isOpen(note) && !note.pending && note.state.expiry_ts > nowSeconds()
    && BigInt(note.state.current_balance) >= BigInt(demo.request_charge_cap);
const searchesOf = note => Number((BigInt(note.state.deposit_amount) - BigInt(note.state.current_balance)) / BigInt(demo.price_units));

function statusOf(note) {
    if (note.exit?.mode === 'escape' && !note.exit.done) return ['escaping', 'escaping'];
    if (note.exit?.done) return ['closed', `closed (${note.exit.mode === 'mutual' ? 'mutual close' : 'escape'})`];
    if (chainStatus.get(note.state.note_id) === 3) return ['claimed', 'expired, swept to treasury'];
    if (note.state.expiry_ts <= nowSeconds() + chainOffset) return ['expired', 'expired: withdraw now'];
    if (note.pending) return ['active', 'search pending'];
    if (!canPay(note)) return ['active', 'balance below one search'];
    return ['active', 'active'];
}

/** The note that pays the next search: the chosen one, or the open note with the least balance that covers it. */
function payer() {
    const choice = $('pay-with').value;
    const notes = myNotes();
    if (choice !== 'auto') {
        const note = notes.find(entry => String(entry.state.note_id) === choice);
        if (!note || !canPay(note)) throw new Error(`Note #${choice} cannot pay for a search now.`);
        return note;
    }
    const usable = notes.filter(canPay).sort((a, b) => Number(BigInt(a.state.current_balance) - BigInt(b.state.current_balance)));
    if (!usable.length) throw new Error('No note can pay for a search: deposit a new note.');
    return usable[0];
}

function fillSelect(select, options) {
    const previous = select.value;
    select.replaceChildren(...options.map(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
    }));
    if (options.some(([value]) => value === previous)) select.value = previous;
}

function render() {
    const notes = myNotes();
    const open = notes.filter(isOpen);
    const total = open.reduce((sum, note) => sum + BigInt(note.state.current_balance), 0n);
    $('balance').textContent = notes.length ? eth(total) : '—';
    $('note-info').textContent = !account ? 'Connect an account to see its notes.' : notes.length
        ? `Private balance across ${open.length} open note${open.length === 1 ? '' : 's'} of ${account.slice(0, 8)}… · ${notes.length - open.length} closed`
        : `No notes for ${account.slice(0, 8)}… yet: deposit to create one.`;
    $('price').textContent = `Each search costs ${eth(demo.price_units)}; the paying note needs at least ${eth(demo.request_charge_cap)}.`;

    $('my-notes').replaceChildren(...notes.slice().reverse().map(note => {
        const [kind, label] = statusOf(note);
        const id = note.state.note_id;
        const row = cellRow([`#${id}`, eth(note.state.deposit_amount), note.exit?.done ? `paid out ${eth(note.exit.paid)}` : eth(note.state.current_balance),
            String(searchesOf(note)), new Date(note.state.expiry_ts * 1000).toLocaleString()], ['', 'num', 'num', 'num', '']);
        if (kind === 'closed' || kind === 'claimed') row.className = 'closed';
        const status = document.createElement('td');
        const pill = document.createElement('span');
        pill.className = `pill ${kind}`;
        pill.textContent = label;
        status.append(pill);
        if (kind === 'escaping') {
            const countdown = document.createElement('span');
            countdown.className = 'muted countdown';
            countdown.dataset.deadline = note.exit.deadline;
            status.append(' ', countdown);
        }
        const action = document.createElement('td');
        if (kind === 'escaping') {
            const button = document.createElement('button');
            button.textContent = 'Finalize';
            button.className = 'finalize';
            button.dataset.deadline = note.exit.deadline;
            button.onclick = guarded(button, () => finalizeEscape(id));
            action.append(button);
        }
        row.append(status, action);
        return row;
    }));

    fillSelect($('pay-with'), [['auto', 'Auto (an open note with enough balance)'],
        ...notes.filter(canPay).map(note => [String(note.state.note_id), `Note #${note.state.note_id} · ${eth(note.state.current_balance)}`])]);
    fillSelect($('withdraw-note'), notes.filter(note => isOpen(note) && !note.pending)
        .map(note => [String(note.state.note_id), `Note #${note.state.note_id} · ${eth(note.state.current_balance)}`]));

    const pendingNote = notes.find(note => note.pending && isOpen(note));
    $('deposit').disabled = !account;
    $('search').disabled = !notes.some(canPay) || Boolean(pendingNote);
    $('retry').hidden = !pendingNote;
    const canExit = Boolean(account && $('withdraw-note').value);
    $('mutual').disabled = !canExit;
    $('escape').disabled = !canExit;
    tick();
}

/** Once a second: escape countdowns and Finalize buttons. */
function tick() {
    const now = nowSeconds() + chainOffset;
    for (const element of document.querySelectorAll('.countdown')) {
        const left = Number(element.dataset.deadline) - now;
        element.textContent = left > 0 ? `finalizable in ${left} s` : 'ready to finalize';
    }
    for (const button of document.querySelectorAll('button.finalize')) {
        button.disabled = !account || Number(button.dataset.deadline) > now;
    }
}

// ------------------------------------------------------------------ wallet
// Anvil's ten default accounts are unlocked and funded; label the two the
// deployment uses.
const ANVIL_ROLES = { 0: 'vault owner', 2: 'treasury' };

async function fillAccounts() {
    const accounts = await rpc('eth_accounts');
    anvilAccounts = accounts.map(address => address.toLowerCase());
    fillSelect($('account-select'), accounts.map((address, index) =>
        [address.toLowerCase(), `#${index} ${address}${ANVIL_ROLES[index] ? ` (${ANVIL_ROLES[index]})` : ''}`]));
    if (!account) $('account-select').value = accounts[1].toLowerCase();
}

async function useAccount(address, how) {
    account = address.toLowerCase();
    const balance = BigInt(await rpc('eth_getBalance', [account, 'latest']));
    $('account').textContent = `${account} · ${(Number(balance / GWEI) / 1e9).toFixed(3)} ETH on chain · ${how}`;
    $('results').replaceChildren();
    $('exit-result').textContent = '';
    log(`using ${account} (${myNotes().length} note${myNotes().length === 1 ? '' : 's'} in this browser)`, 'ok');
    render();
    await refreshOperator();
}

async function connect() {
    const mode = $('wallet-mode').value;
    $('account-row').hidden = mode !== 'anvil';
    if (mode === 'injected') {
        if (!window.ethereum) throw new Error('No browser wallet found. Choose the Anvil test account instead.');
        const [selected] = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }));
        if (chainId !== demo.chain_id) {
            throw new Error(`Switch the wallet to the local Anvil network (chain ${demo.chain_id}, RPC ${demo.rpc_url}).`);
        }
        // Switching accounts in the extension switches the page's wallet too.
        window.ethereum.removeAllListeners?.('accountsChanged');
        window.ethereum.on?.('accountsChanged', ([next]) => next && useAccount(next, 'browser wallet').catch(error => log(error.message, 'err')));
        await useAccount(selected, 'browser wallet');
    } else {
        await useAccount($('account-select').value, 'Anvil test account');
    }
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
    updateNote(noteId, { state: JSON.parse(state), pending: null, exit: null });
    log(`note #${noteId} created: ${eth(amount)}`, 'ok');
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
    const note = payer();
    const noteId = note.state.note_id;
    const started = performance.now();
    const snapshot = await admittedSnapshot(noteId);
    const path = JSON.parse(await prover('treePath', { snapshot: JSON.stringify(snapshot), noteId }));
    log(`note #${noteId} pays; proving membership in a tree of ${snapshot.next_note_id} notes…`);
    const prepared = JSON.parse(await prover('prepareRequest', {
        config: JSON.stringify(walletConfig),
        state: JSON.stringify(note.state),
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
    updateNote(noteId, { state: prepared.state, pending: { request: prepared.request, journal: prepared.journal } });
    await send(noteId);
}

/** Send (or resend) a note's pending request and install the signed successor. */
async function send(noteId = myNotes().find(note => note.pending && isOpen(note))?.state.note_id) {
    const note = load().notes[noteId];
    const { request, journal } = note.pending;
    const response = await fetch('/api/server/v2/requests', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(`${body.error_code}: ${body.error_message}${body.retriable ? ' (press "Resend")' : ''}`);
    }
    const next = await prover('completeResponse', {
        config: JSON.stringify(walletConfig),
        args: JSON.stringify({ state: note.state, journal, response: body }),
    });
    updateNote(noteId, { state: JSON.parse(next), pending: null });
    log(`note #${noteId} paid ${eth(body.charge_applied)}; the server's signature on its new balance verified`, 'ok');
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

function withdrawNote() {
    const note = load().notes[$('withdraw-note').value];
    if (!note || !isOpen(note) || note.pending) throw new Error('Choose an open note to withdraw.');
    return note;
}

async function mutualClose() {
    const note = withdrawNote();
    const noteId = note.state.note_id;
    const to = destination();
    const config = JSON.stringify(walletConfig);
    const state = JSON.stringify(note.state);
    log(`note #${noteId}: proving ownership for the operator's clearance…`);
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
    log(`note #${noteId}: the operator signed the clearance for its balance`, 'ok');
    const plan = JSON.parse(await prover('prepareWithdrawal', {
        config, state, args: JSON.stringify({ mode: 'mutual', destination: to, valid_until: await exitValidUntil(), clearance }),
    }));
    const data = encodeWithdrawal(plan, 'mutual', to, demo.contract_address);
    const hash = await sendAndWait({ from: account, to: demo.contract_address, data, gas: '0x2dc6c0' }, 'mutual close');
    const paid = String(BigInt(plan.public_inputs.final_balance));
    updateNote(noteId, { exit: { mode: 'mutual', done: true, tx: hash, paid, destination: to } });
    $('exit-result').textContent = `Note #${noteId} closed: you received ${eth(paid)}, `
        + `the operator ${eth(BigInt(note.state.deposit_amount) - BigInt(paid))}.`;
    log(`note #${noteId} closed: ${eth(paid)} paid to ${to}`, 'ok');
    await refreshOperator();
}

async function escape() {
    const note = withdrawNote();
    const noteId = note.state.note_id;
    const to = destination();
    log(`note #${noteId}: proving its latest signed balance for an escape (no operator involved)…`);
    const plan = JSON.parse(await prover('prepareWithdrawal', {
        config: JSON.stringify(walletConfig), state: JSON.stringify(note.state),
        args: JSON.stringify({ mode: 'escape', destination: to, conceded: 0, valid_until: await exitValidUntil() }),
    }));
    const data = encodeWithdrawal(plan, 'escape', to, demo.contract_address, { conceded: 0 });
    const hash = await sendAndWait({ from: account, to: demo.contract_address, data, gas: '0x2dc6c0' }, 'escape');
    const pendingEscape = decodePendingWithdrawals(await ethCall(demo.contract_address, encodePendingWithdrawals(noteId)));
    updateNote(noteId, { exit: { mode: 'escape', done: false, tx: hash, destination: to,
        paid: String(pendingEscape.finalBalance), deadline: Number(pendingEscape.challengeDeadline) } });
    $('exit-result').textContent = `Note #${noteId} is escaping: finalize it in My notes after ${demo.challenge_period} s.`;
    log(`note #${noteId}: escape started; finalizable after ${demo.challenge_period} s`, 'ok');
    await refreshOperator();
}

async function finalizeEscape(noteId) {
    const note = load().notes[noteId];
    await sendAndWait({ from: account, to: demo.contract_address, data: encodeFinalizeEscape(noteId), gas: '0x7a120' },
        'finalize escape');
    updateNote(noteId, { exit: { ...note.exit, done: true } });
    $('exit-result').textContent = `Note #${noteId} closed by escape: you received ${eth(note.exit.paid)}.`;
    log(`note #${noteId}: escape finalized, ${eth(note.exit.paid)} paid to ${note.exit.destination}`, 'ok');
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

// Every Anvil account starts with 10,000 ETH; the treasury only receives.
const ANVIL_START_WEI = 10_000n * 10n ** 18n;
const ethWei = wei => `${(Number(BigInt(wei) / GWEI) / 1e9).toFixed(4)} ETH`;
const short = hex => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

function cellRow(values, classes = []) {
    const row = document.createElement('tr');
    values.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (classes[index]) cell.className = classes[index];
        row.append(cell);
    });
    return row;
}

async function refreshAccounts() {
    const owner = `0x${(await ethCall(demo.contract_address, '0x8da5cb5b')).slice(-40)}`; // owner()
    const payout = $('destination').value.trim().toLowerCase();
    const accounts = [
        ['Vault owner (deployed the vault; can pause)', owner],
        ['Treasury (receives the operator\'s share)', demo.treasury],
        ['Vault contract (holds all deposits)', demo.contract_address],
    ];
    if (account) accounts.push(['You (pays deposits, receives withdrawals)', account]);
    if (/^0x[0-9a-f]{40}$/.test(payout) && payout !== account?.toLowerCase()) accounts.push(['Payout destination', payout]);
    const balances = await Promise.all(accounts.map(([, address]) => rpc('eth_getBalance', [address, 'latest'])));
    $('accounts').replaceChildren(...accounts.map(([role, address], index) =>
        cellRow([role, address, ethWei(balances[index])], ['', 'mono', 'num'])));
    return { treasury: BigInt(balances[1]), vault: BigInt(balances[2]) };
}

async function refreshServer() {
    const [summary, recent] = await Promise.all([
        getJSON('/api/server/v1/dashboard/summary'),
        getJSON('/api/server/v1/dashboard/recent'),
    ]);
    $('served').textContent = String(summary.totals.request_count);
    $('charged').textContent = eth(summary.totals.total_gwei_charged);
    $('seen').replaceChildren(...recent.slice().reverse().slice(0, 20).map(event => {
        let query = event.request_raw;
        try {
            query = JSON.parse(event.request_raw).query ?? query;
        } catch {
            // not JSON: show it as sent
        }
        return cellRow([new Date(event.ts_ms).toLocaleTimeString(), query, short(event.request_nullifier), eth(event.charge_applied)],
            ['', '', 'mono', 'num']);
    }));
}

function renderParams(now) {
    const params = [
        ['Price per search', eth(demo.price_units)],
        ['Balance needed per search', eth(demo.request_charge_cap)],
        ['Minimum deposit', eth(demo.min_deposit_units)],
        ['Note TTL', `${demo.note_ttl / 60} min, rounded up to UTC midnight`],
        ['Challenge period', `${demo.challenge_period} s`],
        ['Chain', `${demo.chain_id} (Anvil)`],
        ['Chain time', `${new Date(now * 1000).toLocaleString()}${chainOffset > 60 ? ` (+${Math.round(chainOffset / 60)} min ahead)` : ''}`],
    ];
    $('params').replaceChildren(...params.map(([name, value]) => {
        const item = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = name;
        const detail = document.createElement('dd');
        detail.textContent = value;
        item.append(term, detail);
        return item;
    }));
}

async function refreshOperator() {
    const now = await chainNow();
    chainOffset = now - nowSeconds();
    renderParams(now);
    const { treasury, vault } = await refreshAccounts();
    $('received').textContent = ethWei(treasury - ANVIL_START_WEI);
    $('vault-balance').textContent = ethWei(vault);
    await refreshServer().catch(error => log(`server dashboard: ${error.message}`, 'err'));
    await refreshExplorer().catch(error => log(`explorer: ${error.message}`, 'err'));
    const logs = await rpc('eth_getLogs', [{ address: demo.contract_address, fromBlock: `0x${demo.deploy_block.toString(16)}`,
        toBlock: 'latest', topics: [NOTE_DEPOSITED_TOPIC] }]);
    claimableNotes = [];
    const statusBefore = JSON.stringify([...chainStatus]);
    const rows = [];
    for (const entry of logs) {
        const note = {
            id: Number(BigInt(entry.topics[1])),
            commitment: entry.topics[2],
            amount: BigInt(`0x${entry.data.slice(2, 66)}`),
            expiry: BigInt(`0x${entry.data.slice(66, 130)}`),
        };
        const record = decodeNoteRecord(await ethCall(demo.contract_address, encodeNoteRecord(note.id)));
        chainStatus.set(note.id, record.status);
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
    // Re-render the wallet only when a note's vault status changed, so the
    // periodic refresh does not reset a dropdown the user has open.
    if (JSON.stringify([...chainStatus]) !== statusBefore) render();
}

// ------------------------------------------------------------------ explorer
const ACTIONS = {
    [ABI.deposit]: 'deposit',
    [ABI.mutualClose]: 'mutualClose',
    [ABI.initiateEscapeWithdrawal]: 'initiateEscapeWithdrawal',
    [ABI.finalizeEscapeWithdrawal]: 'finalizeEscapeWithdrawal',
    [ABI.claimExpired]: 'claimExpired',
};
// MutualClose, EscapeWithdrawalInitiated and EscapeWithdrawalFinalized carry
// (nullifier, finalBalance, destination, ...): the destination is data word 2.
const DESTINATION_EVENTS = new Set([ABI.mutualCloseEvent, ABI.escapeInitiatedEvent, ABI.escapeFinalizedEvent]);
const explored = new Map(); // tx hash -> its table row
let anvilAccounts = [];

function addressLabel(address) {
    const lower = address.toLowerCase();
    if (lower === demo.contract_address) return 'vault';
    if (lower === demo.treasury) return 'treasury';
    const index = anvilAccounts.indexOf(lower);
    const name = index >= 0 ? `#${index}${ANVIL_ROLES[index] ? ` ${ANVIL_ROLES[index]}` : ''}` : short(lower);
    return lower === account ? `${name} (you)` : name;
}

async function exploreTx(hash) {
    const [tx, mined] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])]);
    const block = Number(BigInt(mined.blockNumber));
    const involved = new Set([tx.from.toLowerCase(), demo.contract_address, demo.treasury]);
    for (const entry of mined.logs) {
        if (DESTINATION_EVENTS.has(entry.topics[0])) involved.add(`0x${entry.data.slice(2 + 2 * 64 + 24, 2 + 3 * 64)}`);
    }
    const changes = [];
    for (const address of involved) {
        const [before, after] = await Promise.all([
            rpc('eth_getBalance', [address, `0x${(block - 1).toString(16)}`]),
            rpc('eth_getBalance', [address, mined.blockNumber]),
        ]);
        const delta = BigInt(after) - BigInt(before);
        if (delta !== 0n) changes.push({ address, before: BigInt(before), after: BigInt(after), delta });
    }
    const header = await rpc('eth_getBlockByNumber', [mined.blockNumber, false]);
    const row = cellRow([String(block), new Date(Number(BigInt(header.timestamp)) * 1000).toLocaleTimeString(),
        `${tx.to ? ACTIONS[tx.input.slice(2, 10)] ?? tx.input.slice(0, 10) : 'deploy'}${mined.status === '0x1' ? '' : ' (reverted)'}`, short(hash)],
    ['', '', '', 'mono']);
    const cell = document.createElement('td');
    cell.className = 'changes';
    for (const change of changes) {
        const line = document.createElement('div');
        const sign = change.delta > 0n ? '+' : '−';
        const amount = change.delta > 0n ? change.delta : -change.delta;
        const delta = document.createElement('span');
        delta.className = change.delta > 0n ? 'plus' : 'minus';
        // Gas alone is far below 0.0001 ETH: show small changes in gwei.
        delta.textContent = amount < 100_000n * GWEI ? `${sign}${(Number(amount) / 1e9).toFixed(0)} gwei` : `${sign}${ethWei(amount)}`;
        line.append(`${addressLabel(change.address)}: ${ethWei(change.before)} → ${ethWei(change.after)} `, delta);
        cell.append(line);
    }
    row.append(cell);
    return { block, row };
}

async function refreshExplorer() {
    const logs = await rpc('eth_getLogs', [{ address: demo.contract_address, fromBlock: `0x${demo.deploy_block.toString(16)}`, toBlock: 'latest' }]);
    const hashes = [...new Set(logs.map(entry => entry.transactionHash))].filter(hash => !explored.has(hash));
    if (!hashes.length) return;
    for (const hash of hashes) explored.set(hash, await exploreTx(hash));
    const rows = [...explored.values()].sort((a, b) => b.block - a.block).map(entry => entry.row);
    $('txs').replaceChildren(...rows);
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
            // render() re-disables the buttons whose state it manages.
            button.disabled = false;
            render();
        }
    };
}

async function main() {
    demo = await getJSON('/config.json');
    walletPrefix = `zkapi-demo:${demo.chain_id}:${demo.contract_address}`;
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
    $('account-select').onchange = guarded($('account-select'), connect);
    $('wallet-mode').onchange = () => { $('account-row').hidden = $('wallet-mode').value !== 'anvil'; };
    $('deposit').onclick = guarded($('deposit'), deposit);
    $('search-form').onsubmit = guarded($('search'), async () => {
        const query = $('query').value.trim();
        if (query) await search(query);
    });
    $('retry').onclick = guarded($('retry'), () => send());
    $('mutual').onclick = guarded($('mutual'), mutualClose);
    $('escape').onclick = guarded($('escape'), escape);
    $('refresh-notes').onclick = guarded($('refresh-notes'), refreshOperator);
    $('skip-hour').onclick = guarded($('skip-hour'), () => skipTime(3_600, '+1 h'));
    $('skip-expiry').onclick = guarded($('skip-expiry'), async () => {
        const now = await chainNow();
        const next = claimableNotes.filter(at => at > now).sort((a, b) => a - b)[0];
        if (!next) throw new Error('No active note is waiting to expire.');
        await skipTime(next - now + 5, `to ${new Date((next + 5) * 1000).toLocaleString()}`);
    });
    $('withdraw-note').onchange = render;
    $('reset').onclick = () => {
        if (!account) return;
        if (confirm(`Forget every note of ${account}? Their secrets are only in this browser: open notes become unspendable from here.`)) {
            localStorage.removeItem(storageKey());
            render();
            log(`all notes of ${account} forgotten`);
        }
    };
    await fillAccounts();
    render();
    setInterval(tick, 1_000);
    setInterval(() => refreshOperator().catch(() => {}), 5_000);
    refreshOperator().catch(error => log(error.message, 'err'));
    log(`prover loaded (setup ${await prover('setupId')}), vault ${demo.contract_address}`);
}

main().catch(error => log(error.message, 'err'));
