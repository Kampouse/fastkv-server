// NEAR Garden — Wallet + Write (__fastdata_kv)
// Uses near-kit + HOT connector (ESM)

import { Near, fromHotConnect } from "near-kit";
import { NearConnector } from "@hot-labs/near-connect";

const NEAR_NETWORK = 'mainnet';

let near = null;
let connector = null;
let connectedAccountId = null;
let writeBatchMode = false;

// ── Helpers ─────────────────────────────────────────────────

function getTargetContract() {
  const el = document.getElementById('contract-input');
  return (el && el.value) || 'contextual.near';
}

// ── Init ────────────────────────────────────────────────────

async function initNear() {
  connector = new NearConnector();

  connector.on("wallet:signIn", (data) => {
    const accounts = data.accounts || [];
    connectedAccountId = accounts.length > 0 ? accounts[0].accountId : null;
    if (connectedAccountId) {
      near = new Near({
        network: NEAR_NETWORK,
        wallet: fromHotConnect(connector),
      });
    }
    renderWalletUI();
  });

  connector.on("wallet:signOut", () => {
    connectedAccountId = null;
    near = null;
    renderWalletUI();
    if (typeof viewMode !== 'undefined' && viewMode === 'write') {
      if (typeof setViewMode === 'function') setViewMode('tree');
    }
  });

  // Clean up legacy near-api-js localStorage keys
  if (localStorage.getItem('near-garden_wallet_auth_key')) {
    localStorage.removeItem('near-garden_wallet_auth_key');
    localStorage.removeItem('near-garden-contract');
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('near-api-js:keystore:')) {
        localStorage.removeItem(key);
      }
    }
  }

  renderWalletUI();
}

function walletIsSignedIn() {
  return connectedAccountId !== null;
}

function walletGetAccountId() {
  return connectedAccountId;
}

function walletSignIn() {
  if (!connector) return;
  connector.connect();
}

function walletSignOut() {
  if (!connector) return;
  connectedAccountId = null;
  near = null;
  renderWalletUI();
  if (typeof viewMode !== 'undefined' && viewMode === 'write') {
    if (typeof setViewMode === 'function') setViewMode('tree');
  }
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
    // Enable the write tab
    const writeBtn = document.getElementById('view-write');
    if (writeBtn) { writeBtn.hidden = false; writeBtn.disabled = false; }
    // Hide connect prompt, show write form
    const connectPrompt = document.getElementById('write-connect-prompt');
    if (connectPrompt) connectPrompt.hidden = true;
    const writeHeader = document.querySelector('.write-header');
    if (writeHeader) writeHeader.parentElement.querySelectorAll('.write-header, #write-single, #write-batch, .write-preview, .write-note, .write-btn, .write-status').forEach(el => el.style.display = '');
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wallet-btn connect';
    btn.textContent = 'connect wallet';
    btn.onclick = walletSignIn;
    container.append(btn);
    // Disable the write tab
    const writeBtn = document.getElementById('view-write');
    if (writeBtn) { writeBtn.hidden = true; writeBtn.disabled = true; }
    // Show connect prompt, hide write form
    const connectPrompt = document.getElementById('write-connect-prompt');
    if (connectPrompt) connectPrompt.hidden = false;
    const writeHeader = document.querySelector('.write-header');
    if (writeHeader) writeHeader.parentElement.querySelectorAll('.write-header, #write-single, #write-batch, .write-preview, .write-note, .write-btn, .write-status').forEach(el => el.style.display = 'none');
  }
}

// ── Batch mode toggle ───────────────────────────────────────

function toggleBatchMode() {
  writeBatchMode = !writeBatchMode;
  syncBatchUI();
  updateWritePreview();
  if (typeof pushHash === 'function') pushHash();
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
  if (!walletIsSignedIn() || !near) return;

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

  if (writeBtn) { writeBtn.disabled = true; writeBtn.textContent = '...'; }
  if (statusEl) statusEl.textContent = 'signing transaction...';

  try {
    await near.call(targetContract, '__fastdata_kv', args, { gas: '30 Tgas' });

    if (statusEl) statusEl.textContent = 'saved! waiting for indexer...';
    pollForIndexed(walletGetAccountId(), firstKey, targetContract);
  } catch (e) {
    console.error('Write failed:', e);
    const msg = e.message || 'unknown error';
    const isRejected = msg.includes('User denied') || msg.includes('rejected') || msg.includes('cancelled');
    if (statusEl) statusEl.textContent = isRejected ? 'transaction cancelled' : `failed: ${msg}`;
    if (writeBtn) { writeBtn.disabled = false; writeBtn.textContent = 'write_'; }
  }
}

async function pollForIndexed(accountId, key, targetContract) {
  const statusEl = document.getElementById('write-status');
  const writeBtn = document.getElementById('write-btn');
  const API = '';

  let delay = 2000;
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
  if (typeof currentAccount !== 'undefined') currentAccount = accountId;
  const qi = document.getElementById('query-input');
  if (qi) qi.value = `${keyPath}/**`;
  if (typeof breadcrumb !== 'undefined') breadcrumb = [accountId, ...keyPath.split('/')];
  if (typeof setViewMode === 'function') setViewMode('tree');
  if (typeof explore === 'function') explore(`${keyPath}/**`);
}

// ── Expose API for app.js and inline handlers ───────────────

window.walletIsSignedIn = walletIsSignedIn;
window.walletGetAccountId = walletGetAccountId;
window.walletSignIn = walletSignIn;
window.walletSignOut = walletSignOut;
window.initNear = initNear;
window.writeData = writeData;
window.toggleBatchMode = toggleBatchMode;
window.updateWritePreview = updateWritePreview;
window.syncBatchUI = syncBatchUI;
window.setWriteFields = setWriteFields;
Object.defineProperty(window, 'writeBatchMode', {
  get() { return writeBatchMode; },
  set(v) { writeBatchMode = v; },
});
