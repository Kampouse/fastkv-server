// NEAR Garden — Wallet + Write (__fastdata_kv)
// Depends on near-api-js loaded via CDN (global nearApi)

const NEAR_NETWORK = 'mainnet';
const NEAR_NODE_URL = 'https://rpc.mainnet.near.org';
const NEAR_WALLET_URL = 'https://app.mynearwallet.com';
const APP_KEY_PREFIX = 'near-garden';
const SIGNED_CONTRACT_KEY = 'near-garden-contract';

let nearConnection = null;
let walletConnection = null;
let writeBatchMode = false;

// ── Helpers ─────────────────────────────────────────────────

function getTargetContract() {
  const el = document.getElementById('contract-input');
  return (el && el.value) || 'contextual.near';
}

function getSignedInContract() {
  return localStorage.getItem(SIGNED_CONTRACT_KEY);
}

// ── Init ────────────────────────────────────────────────────

async function initNear() {
  const keyStore = new nearApi.keyStores.BrowserLocalStorageKeyStore();
  nearConnection = await nearApi.connect({
    networkId: NEAR_NETWORK,
    keyStore,
    nodeUrl: NEAR_NODE_URL,
    walletUrl: NEAR_WALLET_URL,
    headers: {},
  });
  walletConnection = new nearApi.WalletConnection(nearConnection, APP_KEY_PREFIX);
  renderWalletUI();

  // If just returned from wallet redirect, check for pending write
  if (walletIsSignedIn()) {
    const pending = sessionStorage.getItem('near-garden-pending-write');
    if (pending) {
      sessionStorage.removeItem('near-garden-pending-write');
      try {
        const { key, value, batchJson, contract, batchMode } = JSON.parse(pending);
        // Restore contract input
        if (contract) {
          const el = document.getElementById('contract-input');
          if (el) el.value = contract;
        }
        // Restore batch mode
        if (batchMode) {
          writeBatchMode = true;
          syncBatchUI();
          const ta = document.getElementById('write-batch-input');
          if (ta) ta.value = batchJson || '';
        } else {
          writeBatchMode = false;
          syncBatchUI();
          setWriteFields(key, value);
        }
        setViewMode('write');
        pushHash();
      } catch (_) { /* ignore corrupt data */ }
    }
  }
}

function walletIsSignedIn() {
  return walletConnection && walletConnection.isSignedIn();
}

function walletGetAccountId() {
  return walletConnection ? walletConnection.getAccountId() : null;
}

function walletSignIn() {
  if (!walletConnection) return;
  const contract = getTargetContract();
  localStorage.setItem(SIGNED_CONTRACT_KEY, contract);
  walletConnection.requestSignIn({ contractId: contract });
}

function walletSignOut() {
  if (!walletConnection) return;
  walletConnection.signOut();
  localStorage.removeItem(SIGNED_CONTRACT_KEY);
  renderWalletUI();
  // If on write tab, switch back to tree
  if (viewMode === 'write') setViewMode('tree');
}

// ── Wallet UI ───────────────────────────────────────────────

function renderWalletUI() {
  const container = document.getElementById('wallet-area');
  if (!container) return;

  container.textContent = '';

  if (walletIsSignedIn()) {
    const accountId = walletGetAccountId();
    const span = document.createElement('span');
    span.className = 'wallet-account';
    span.textContent = accountId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wallet-btn disconnect';
    btn.textContent = 'disconnect';
    btn.onclick = walletSignOut;
    container.append(span, btn);
    // Auto-fill account field only if still on the default value
    const acctInput = document.getElementById('account-input');
    if (acctInput && acctInput.value === 'root.near') {
      acctInput.value = accountId;
    }
    // Show the write tab
    const writeBtn = document.getElementById('view-write');
    if (writeBtn) writeBtn.hidden = false;
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wallet-btn connect';
    btn.textContent = 'connect wallet';
    btn.onclick = walletSignIn;
    container.append(btn);
    // Hide the write tab
    const writeBtn = document.getElementById('view-write');
    if (writeBtn) writeBtn.hidden = true;
  }

  checkContractMismatch();
}

// ── Contract mismatch guard ─────────────────────────────────

function checkContractMismatch() {
  const mismatchEl = document.getElementById('write-mismatch');
  const writeBtn = document.getElementById('write-btn');
  if (!mismatchEl) return;

  if (!walletIsSignedIn()) {
    mismatchEl.hidden = true;
    return;
  }

  const signed = getSignedInContract();
  const target = getTargetContract();

  if (signed && signed !== target) {
    mismatchEl.hidden = false;
    mismatchEl.innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = `wallet connected to ${signed}`;
    const reconnBtn = document.createElement('button');
    reconnBtn.type = 'button';
    reconnBtn.className = 'mismatch-reconnect';
    reconnBtn.textContent = `reconnect for ${target}`;
    reconnBtn.onclick = () => {
      walletSignOut();
      walletSignIn();
    };
    mismatchEl.append(msg, reconnBtn);
    if (writeBtn) writeBtn.disabled = true;
  } else {
    mismatchEl.hidden = true;
    if (writeBtn) writeBtn.disabled = false;
  }
}

// ── Batch mode toggle ───────────────────────────────────────

function toggleBatchMode() {
  writeBatchMode = !writeBatchMode;
  syncBatchUI();
  updateWritePreview();
  pushHash();
}

function syncBatchUI() {
  const singleEl = document.getElementById('write-single');
  const batchEl = document.getElementById('write-batch');
  const toggleBtn = document.getElementById('write-mode-toggle');
  if (singleEl) singleEl.hidden = writeBatchMode;
  if (batchEl) batchEl.hidden = !writeBatchMode;
  if (toggleBtn) {
    toggleBtn.textContent = writeBatchMode ? 'single' : 'batch';
    toggleBtn.classList.toggle('active', writeBatchMode);
  }
}

// ── Write helpers ───────────────────────────────────────────

function setWriteFields(key, value) {
  const keyInput = document.getElementById('write-key');
  const valueInput = document.getElementById('write-value');
  if (keyInput) keyInput.value = key || '';
  if (valueInput) valueInput.value = value || '';
  updateWritePreview();
}

function updateWritePreview() {
  const preview = document.getElementById('write-preview');
  if (!preview) return;
  const accountId = walletGetAccountId() || 'you.near';
  const contract = getTargetContract();

  if (writeBatchMode) {
    const ta = document.getElementById('write-batch-input');
    let count = 0;
    try {
      const obj = JSON.parse((ta && ta.value) || '{}');
      count = Object.keys(obj).length;
    } catch (_) { /* invalid JSON */ }
    preview.textContent = `${accountId} \u2192 ${contract}::__fastdata_kv({ ${count} key${count !== 1 ? 's' : ''} })`;
  } else {
    const keyInput = document.getElementById('write-key');
    const key = (keyInput && keyInput.value) || '(key)';
    preview.textContent = `${accountId} \u2192 ${contract}::__fastdata_kv("${key}", ...)`;
  }
}

function buildWriteArgs() {
  if (writeBatchMode) {
    const ta = document.getElementById('write-batch-input');
    const raw = (ta && ta.value || '').trim();
    if (!raw) throw new Error('enter key-value pairs as JSON');
    let obj;
    try { obj = JSON.parse(raw); } catch (_) { throw new Error('invalid JSON'); }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error('expected a JSON object like {"key": "value"}');
    }
    // Validate all values are string or null
    for (const [k, v] of Object.entries(obj)) {
      if (!k.trim()) throw new Error('keys must be non-empty strings');
      if (v !== null && typeof v !== 'string') {
        throw new Error(`value for "${k}" must be a string or null`);
      }
    }
    return obj;
  }

  // Single mode
  const keyInput = document.getElementById('write-key');
  const valueInput = document.getElementById('write-value');
  const key = (keyInput && keyInput.value || '').trim();
  if (!key) throw new Error('enter a key');
  const value = (valueInput && valueInput.value) || '';
  return { [key]: value };
}

// ── Write (__fastdata_kv) ───────────────────────────────────

async function writeData() {
  if (!walletIsSignedIn()) return;

  const statusEl = document.getElementById('write-status');
  const writeBtn = document.getElementById('write-btn');

  let args;
  try {
    args = buildWriteArgs();
  } catch (e) {
    if (statusEl) statusEl.textContent = e.message;
    return;
  }

  const targetContract = getTargetContract();
  const firstKey = Object.keys(args)[0];

  // Save intent in case of wallet redirect
  const pending = { contract: targetContract, batchMode: writeBatchMode };
  if (writeBatchMode) {
    const ta = document.getElementById('write-batch-input');
    pending.batchJson = ta ? ta.value : '';
  } else {
    const keyInput = document.getElementById('write-key');
    const valueInput = document.getElementById('write-value');
    pending.key = keyInput ? keyInput.value : '';
    pending.value = valueInput ? valueInput.value : '';
  }
  sessionStorage.setItem('near-garden-pending-write', JSON.stringify(pending));

  if (writeBtn) { writeBtn.disabled = true; writeBtn.textContent = '...'; }
  if (statusEl) statusEl.textContent = 'signing transaction...';

  try {
    const account = walletConnection.account();
    await account.functionCall({
      contractId: targetContract,
      methodName: '__fastdata_kv',
      args,
      gas: '30000000000000', // 30 TGas
    });

    // If we get here (unlikely with redirect wallet), write succeeded
    sessionStorage.removeItem('near-garden-pending-write');
    if (statusEl) statusEl.textContent = 'saved! waiting for indexer...';
    pollForIndexed(walletGetAccountId(), firstKey, targetContract);
  } catch (e) {
    console.error('Write failed:', e);
    sessionStorage.removeItem('near-garden-pending-write');
    const msg = e.message || 'unknown error';
    const isRejected = msg.includes('User denied') || msg.includes('rejected') || msg.includes('cancelled');
    if (statusEl) statusEl.textContent = isRejected ? 'transaction cancelled' : `failed: ${msg}`;
    if (writeBtn) { writeBtn.disabled = false; writeBtn.textContent = 'write_'; }
  }
}

async function pollForIndexed(accountId, key, targetContract) {
  const statusEl = document.getElementById('write-status');
  const writeBtn = document.getElementById('write-btn');

  let delay = 2000; // start at 2s, backoff 1.5x each round
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, delay));
    try {
      const res = await fetch(`${API}/v1/kv/get?accountId=${encodeURIComponent(accountId)}&contractId=${encodeURIComponent(targetContract)}&key=${encodeURIComponent(key)}`);
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          if (statusEl) {
            statusEl.textContent = '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'write-view-btn';
            btn.textContent = 'view in explorer';
            btn.onclick = () => viewWrittenData(accountId, key);
            statusEl.append('indexed! ', btn);
          }
          if (writeBtn) { writeBtn.disabled = false; writeBtn.textContent = 'write_'; }
          return;
        }
      }
    } catch (_) { /* retry */ }
    delay = Math.min(delay * 1.5, 10000);
    if (statusEl) statusEl.textContent = `waiting for indexer... (${i + 1})`;
  }

  if (statusEl) statusEl.textContent = 'indexing may take a moment \u2014 try exploring in a few seconds';
  if (writeBtn) { writeBtn.disabled = false; writeBtn.textContent = 'write_'; }
}

function viewWrittenData(accountId, keyPath) {
  const acctInput = document.getElementById('account-input');
  if (acctInput) acctInput.value = accountId;
  currentAccount = accountId;
  if (queryInput) queryInput.value = `${keyPath}/**`;
  breadcrumb = [accountId, ...keyPath.split('/')];
  setViewMode('tree');
  explore(`${keyPath}/**`);
}
