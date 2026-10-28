// The browser prover (sdk/wasm, the development setup) in a worker, so a
// proof does not freeze the page. Messages: { id, call, args } where `call`
// is a zkapi_browser export; replies { id, result } or { id, error }.
import init, * as wasm from '/wasm/zkapi_browser.js';

let prover = null;

async function ready() {
    if (prover) return prover;
    await init({ module_or_path: '/wasm/zkapi_browser_bg.wasm' });
    const key = new Uint8Array(await (await fetch('/proofs/request.pk')).arrayBuffer());
    prover = new wasm.BrowserRequestProver(key);
    return prover;
}

const calls = {
    setupId: async () => (await ready(), wasm.browser_setup_id()),
    generateDeposit: async () => (await ready(), wasm.browser_generate_deposit()),
    confirmDeposit: async ({ config, args }) => (await ready(), wasm.browser_confirm_deposit(config, args)),
    treePath: async ({ snapshot, noteId }) => (await ready(), wasm.browser_tree_path(snapshot, noteId, true)),
    prepareRequest: async ({ config, state, args }) => (await ready()).prepare_request(config, state, args),
    completeResponse: async ({ config, args }) => (await ready(), wasm.browser_complete_response(config, args)),
    walletStatus: async ({ state }) => (await ready(), wasm.browser_wallet_status(state, undefined)),
};

self.onmessage = async ({ data: { id, call, args } }) => {
    try {
        self.postMessage({ id, result: await calls[call](args ?? {}) });
    } catch (error) {
        self.postMessage({ id, error: String(error?.message ?? error) });
    }
};
