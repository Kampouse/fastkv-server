// NEAR Garden — Explorer
// Vanilla JS, no build step

const API = '';
const EXPLORER_URL = 'https://nearblocks.io/txns';

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function tryFormatJson(v) {
  if (typeof v !== 'string') return JSON.stringify(v, null, 2);
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
}

function buildUrl(path, params) {
  const base = API || location.origin;
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\"'\"'") + "'";
}

function curlCmd(url) { return `curl -s ${shQuote(url)} | jq`; }

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  } catch { prompt('Copy:', text); }
}

// ── Hash state ─────────────────────────────────────────────

let hashPushing = false;

function buildHash() {
  const p = new URLSearchParams();
  if (viewMode === 'write') {
    p.set('view', 'write');
    p.set('contract', contractId);
    const keyEl = document.getElementById('write-key');
    if (keyEl && keyEl.value) p.set('key', keyEl.value);
    const valEl = document.getElementById('write-value');
    if (valEl && valEl.value) p.set('value', valEl.value);
  } else {
    if (contractId) p.set('contract', contractId);
    if (currentAccount) p.set('account', currentAccount);
    const q = (queryInput.value || '').replace(/\/?\*+$/, '');
    if (q) p.set('key', q);
    if (viewMode !== 'tree') p.set('view', viewMode);
    if (allContractsCheck && allContractsCheck.checked) p.set('allContracts', '1');
    if (multiAccountMode) p.set('allAccounts', '1');
  }
  return p.toString();
}

function pushHash() {
  const h = buildHash();
  if (location.hash.slice(1) !== h) {
    hashPushing = true;
    location.hash = h || '';
    hashPushing = false;
  }
}

function readHash() {
  const raw = location.hash.slice(1);
  if (!raw) return false;
  const p = new URLSearchParams(raw);

  const c = p.get('contract');
  const isAllContracts = p.get('allContracts') === '1' || !c;
  if (isAllContracts) {
    contractId = '';
    contractInput.value = '';
    contractInput.disabled = true;
    if (allContractsCheck) allContractsCheck.checked = true;
  } else {
    contractId = c;
    contractInput.value = c;
    contractInput.disabled = false;
    if (allContractsCheck) allContractsCheck.checked = false;
  }

  const view = p.get('view') || 'tree';
  const key = p.get('key') || '';

  if (view === 'write') {
    if (key) {
      const keyEl = document.getElementById('write-key');
      if (keyEl) keyEl.value = key;
    }
    const val = p.get('value');
    if (val != null) {
      const valEl = document.getElementById('write-value');
      if (valEl) valEl.value = val;
    }
    setViewMode('write');
    return true;
  }

  const acct = p.get('account') || '';
  const isAllAccounts = p.get('allAccounts') === '1' || (!acct && !p.has('account'));

  if (isAllAccounts) {
    multiAccountMode = true;
    currentAccount = '';
    accountInput.value = '';
    accountInput.disabled = true;
    if (allAccountsCheck) allAccountsCheck.checked = true;
  } else {
    multiAccountMode = false;
    currentAccount = acct;
    accountInput.value = acct;
    accountInput.disabled = false;
    if (allAccountsCheck) allAccountsCheck.checked = false;
  }

  if (key) {
    queryInput.value = key + '/**';
    breadcrumb = currentAccount ? [currentAccount, ...key.split('/')] : key.split('/');
  } else {
    queryInput.value = '';
    breadcrumb = currentAccount ? [currentAccount] : [];
  }

  if (view === 'feed') {
    setViewMode('feed');
    loadFeed(currentAccount);
  } else {
    if (view === 'json') setViewMode('json');
    explore(key ? key + '/**' : '');
  }
  return true;
}

// ── API Inspector state ────────────────────────────────────

let lastApiCall = null;

function logApiCall(method, url, body, status) {
  lastApiCall = { method, url, body, status, time: Date.now() };
  renderInspector();
}

function renderInspector() {
  const inspector = document.getElementById('api-inspector');
  const summary = document.getElementById('inspector-summary');
  const detail = document.getElementById('inspector-body');
  const toggle = document.getElementById('inspector-detail');
  if (!inspector || !lastApiCall) return;

  inspector.hidden = false;
  const { method, url, body, status } = lastApiCall;
  const path = url.replace(window.location.origin, '');
  summary.textContent = `${method} ${path} — ${status}`;

  const arrow = document.getElementById('inspector-arrow');
  if (method === 'POST' && body) {
    detail.textContent = JSON.stringify(body, null, 2);
    if (toggle) toggle.hidden = false;
    if (arrow) arrow.hidden = false;
  } else {
    detail.textContent = '';
    if (toggle) toggle.hidden = true;
    if (arrow) { arrow.hidden = true; arrow.classList.remove('open'); }
  }
}

function toggleInspector() {
  const detail = document.getElementById('inspector-detail');
  const arrow = document.getElementById('inspector-arrow');
  const body = document.getElementById('inspector-body');
  if (!detail || !body || !body.textContent) return;
  const open = detail.hidden;
  detail.hidden = !open;
  arrow.classList.toggle('open', open);
}

function copyAsCurl() {
  if (!lastApiCall) return;
  const { method, url, body } = lastApiCall;
  let cmd;
  if (method === 'POST' && body) {
    cmd = `curl -s -X POST ${shQuote(url)} -H 'Content-Type: application/json' -d ${shQuote(JSON.stringify(body))} | jq`;
  } else {
    cmd = `curl -s ${shQuote(url)} | jq`;
  }
  copyText(cmd, document.getElementById('inspector-copy'));
}

// ── API Client ──────────────────────────────────────────────

async function kvContracts(opts) {
  const params = {};
  params.scan = '1';
  if (opts?.accountId) params.accountId = opts.accountId;
  if (opts?.limit) params.limit = String(opts.limit);
  if (opts?.after_contract) params.after_contract = opts.after_contract;
  const url = buildUrl('/v1/kv/contracts', params);
  const res = await fetch(url);
  logApiCall('GET', url, null, res.status);
  if (!res.ok) throw new Error(`kvContracts: ${res.status}`);
  const json = await res.json();
  return { contracts: json.data || [], meta: json.meta || {} };
}

async function kvAccounts(contractId, opts) {
  const params = { contractId };
  if (opts?.limit) params.limit = String(opts.limit);
  if (opts?.offset != null) params.offset = String(opts.offset);
  if (opts?.after_account) params.after_account = opts.after_account;
  const url = buildUrl('/v1/kv/accounts', params);
  const res = await fetch(url);
  logApiCall('GET', url, null, res.status);
  if (!res.ok) throw new Error(`kvAccounts: ${res.status}`);
  const json = await res.json();
  return { accounts: json.data || [], meta: json.meta || {} };
}

async function kvGet(accountId, contractId, key) {
  const params = new URLSearchParams({ accountId, contractId, key, value_format: 'json' });
  const url = `${API}/v1/kv/get?${params}`;
  const res = await fetch(url);
  logApiCall('GET', url, null, res.status);
  if (!res.ok) throw new Error(`kvGet: ${res.status}`);
  const json = await res.json();
  return json.data; // KvEntry | null
}

async function kvTimeline(accountId, contractId, limit) {
  const params = new URLSearchParams({
    accountId,
    contractId,
    limit: String(limit || 20),
    value_format: 'json',
  });
  const url = `${API}/v1/kv/timeline?${params}`;
  const res = await fetch(url);
  logApiCall('GET', url, null, res.status);
  if (!res.ok) throw new Error(`kvTimeline: ${res.status}`);
  return res.json();
}

async function kvHistory(accountId, contractId, key, limit) {
  const params = new URLSearchParams({
    accountId,
    contractId,
    key,
    value_format: 'json',
    order: 'desc',
    limit: String(limit || 50),
  });
  const url = `${API}/v1/kv/history?${params}`;
  const res = await fetch(url);
  logApiCall('GET', url, null, res.status);
  if (!res.ok) throw new Error(`kvHistory: ${res.status}`);
  const json = await res.json();
  return { entries: json.data || [], meta: json.meta || {} };
}

async function kvWriters(contractId, key, limit) {
  const params = new URLSearchParams({
    contractId,
    key,
    value_format: 'json',
    limit: String(limit || 20),
  });
  const url = `${API}/v1/kv/writers?${params}`;
  const res = await fetch(url);
  logApiCall('GET', url, null, res.status);
  if (!res.ok) throw new Error(`kvWriters: ${res.status}`);
  return res.json();
}

async function kvDiff(accountId, contractId, key, blockA, blockB) {
  const params = new URLSearchParams({
    accountId, contractId, key,
    block_height_a: String(blockA),
    block_height_b: String(blockB),
    value_format: 'json',
  });
  const url = `${API}/v1/kv/diff?${params}`;
  const res = await fetch(url);
  logApiCall('GET', url, null, res.status);
  if (!res.ok) throw new Error(`kvDiff: ${res.status}`);
  const json = await res.json();
  return json.data; // { a: KvEntry|null, b: KvEntry|null }
}

async function kvQueryTree(accountId, contractId, keyPrefix) {
  const params = new URLSearchParams({
    accountId, contractId,
    format: 'tree',
    value_format: 'json',
    exclude_deleted: 'true',
    limit: '1000',
  });
  if (keyPrefix) params.set('key_prefix', keyPrefix);
  const url = `${API}/v1/kv/query?${params}`;
  const res = await fetch(url);
  logApiCall('GET', url, null, res.status);
  if (!res.ok) throw new Error(`kvQueryTree: ${res.status}`);
  const json = await res.json();
  const tree = json.tree ?? json.data ?? null;
  if (json.has_more) lastTreeTruncated = true;
  return tree;
}

// ── State ───────────────────────────────────────────────────

let currentAccount = '';
let contractId = '';
let viewMode = 'tree'; // 'tree' | 'json' | 'write' | 'feed'
let treeData = null;
let lastKeyPrefix = undefined;
let lastTreeTruncated = false;
let rawData = null;
let breadcrumb = [];
let loading = false;
let multiAccountMode = true;
let currentSelectedPath = null;
let currentHistoryEntries = [];

// ── DOM refs ────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const contractInput = $('#contract-input');
const accountInput = $('#account-input');
const queryInput = $('#query-input');
const exploreBtn = $('#explore-btn');
const exploreForm = $('#explore-form');
const breadcrumbEl = $('#breadcrumb');
const viewTreeBtn = $('#view-tree');
const viewJsonBtn = $('#view-json');
const errorBar = $('#error-bar');
const errorMsg = $('#error-msg');
const retryBtn = $('#retry-btn');
const contentEl = $('#content');
const treePanel = $('#tree-panel');
const treeEl = $('#tree');
const detailPanel = $('#detail-panel');
const detailPath = $('#detail-path');
const detailValue = $('#detail-value');
const detailMeta = $('#detail-meta');
const jsonPanel = $('#json-panel');
const jsonView = $('#json-view');
const feedPanel = $('#feed-panel');
const feedList = $('#feed-list');
const allContractsCheck = $('#all-contracts-check');
const allAccountsCheck = $('#all-accounts-check');
const historyPanel = $('#history-panel');
const historyList = $('#history-list');
const diffSelectA = $('#diff-select-a');
const diffSelectB = $('#diff-select-b');
const diffBtn = $('#diff-btn');
const diffResult = $('#diff-result');
const diffCopyBar = $('#diff-copy-bar');

// ── Explorer ────────────────────────────────────────────────

const MULTI_ACCOUNT_CAP = 200;

async function explore(keyPath) {
  const allContracts = allContractsCheck && allContractsCheck.checked;
  contractId = allContracts ? '' : contractInput.value.trim();

  loading = true;
  exploreBtn.disabled = true;
  exploreBtn.textContent = '...';
  hideError();
  hideDetail();
  treeEl.innerHTML = '<div class="tree-loading">loading...</div>';

  if (allContracts) {
    // Contract discovery mode: list all contracts (or contracts for a specific account)
    const acct = accountInput.value.trim();
    try {
      const opts = { limit: MULTI_ACCOUNT_CAP };
      if (acct) opts.accountId = acct;
      const { contracts } = await kvContracts(opts);
      if (contracts.length === 0) {
        treeData = null;
        rawData = null;
      } else {
        const placeholder = {};
        contracts.forEach(c => { placeholder[c] = {}; });
        treeData = placeholder;
        rawData = placeholder;
      }
    } catch (e) {
      showError('Failed to fetch contracts');
      console.error(e);
      treeData = null;
      rawData = null;
    }
    loading = false;
    exploreBtn.disabled = false;
    exploreBtn.textContent = 'explore_';
    render();
    pushHash();
    return;
  }

  multiAccountMode = allAccountsCheck && allAccountsCheck.checked;
  currentAccount = multiAccountMode ? '' : (accountInput.value.trim() || '');

  const keyPrefix = (keyPath || queryInput.value || '').replace(/\/?\*+$/, '') || undefined;
  lastKeyPrefix = keyPrefix;
  lastTreeTruncated = false;

  try {
    if (!multiAccountMode && currentAccount) {
      // ── Single-account: KV only ──
      const tree = await kvQueryTree(currentAccount, contractId, keyPrefix);
      if (tree && Object.keys(tree).length > 0) {
        treeData = { [currentAccount]: tree };
        rawData = treeData;
      } else {
        treeData = null;
        rawData = null;
      }
    } else {
      // ── All accounts: fetch account list, lazy-load data on expand ──
      const { accounts } = await kvAccounts(contractId, { limit: MULTI_ACCOUNT_CAP });
      if (accounts.length === 0) {
        showError('No accounts found for this contract');
        treeData = null;
        rawData = null;
      } else {
        // Create placeholder entries — tree data loads on expand
        const placeholder = {};
        accounts.forEach(acct => { placeholder[acct] = {}; });
        treeData = placeholder;
        rawData = placeholder;
        if (accounts.length >= MULTI_ACCOUNT_CAP) {
          showError(`Showing first ${MULTI_ACCOUNT_CAP} accounts — more may exist`);
        }
      }
    }
  } catch (e) {
    showError('Failed to fetch data');
    console.error(e);
  }

  loading = false;
  exploreBtn.disabled = false;
  exploreBtn.textContent = 'explore_';

  // Switch to tree view to show results
  if (viewMode === 'feed') setViewMode('tree');
  else render();

  pushHash();
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorBar.hidden = false;
}

function hideError() {
  errorBar.hidden = true;
}

// ── Breadcrumb ──────────────────────────────────────────────

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = '';

  const root = document.createElement('button');
  root.textContent = '~';
  root.type = 'button';
  root.onclick = () => navigateBreadcrumb([]);
  breadcrumbEl.appendChild(root);

  breadcrumb.filter(Boolean).forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    breadcrumbEl.appendChild(sep);

    if (i < breadcrumb.length - 1) {
      const btn = document.createElement('button');
      btn.textContent = seg;
      btn.type = 'button';
      btn.onclick = () => navigateBreadcrumb(breadcrumb.slice(0, i + 1));
      breadcrumbEl.appendChild(btn);
    } else {
      const span = document.createElement('span');
      span.className = 'current';
      span.textContent = seg;
      breadcrumbEl.appendChild(span);
    }
  });
}

function navigateBreadcrumb(segments) {
  if (segments.length === 0) {
    queryInput.value = '';
    breadcrumb = [];
    explore();
  } else {
    setAccount(segments[0]);
    if (segments.length === 1) {
      queryInput.value = '';
      breadcrumb = [currentAccount];
      explore();
    } else {
      const keyPath = segments.slice(1).join('/');
      queryInput.value = `${keyPath}/**`;
      breadcrumb = segments;
      explore(`${keyPath}/**`);
    }
  }
}

// ── Tree rendering ──────────────────────────────────────────

function renderEmptyState() {
  const prefix = lastKeyPrefix;
  const el = document.createElement('div');
  el.className = 'tree-empty';

  let heading = '';
  let detail = '';
  if (!contractId) {
    const acct = accountInput.value.trim();
    heading = acct ? `No contracts found for ${esc(acct)}` : 'No contracts found';
  } else if (prefix) {
    heading = `No entries under "${esc(prefix)}/"`;
    detail = currentAccount
      ? `for ${esc(currentAccount)} on ${esc(contractId)}`
      : `on ${esc(contractId)}`;
  } else {
    heading = 'No data found';
    detail = currentAccount
      ? `${esc(currentAccount)} has no entries on ${esc(contractId)}`
      : `no entries on ${esc(contractId)}`;
  }

  let html = `<div class="empty-heading">${heading}</div>`;
  if (detail) html += `<div class="empty-detail">${detail}</div>`;

  el.innerHTML = html;
  treeEl.appendChild(el);
}

function renderTree() {
  treeEl.innerHTML = '';

  if (loading && !treeData) {
    treeEl.innerHTML = '<div class="tree-loading">loading...</div>';
    return;
  }

  if (!treeData) {
    renderEmptyState();
    return;
  }

  if (!contractId) {
    // Contract discovery mode: show contracts as expandable nodes
    const contracts = Object.keys(treeData);
    if (contracts.length === 0) {
      renderEmptyState();
      return;
    }
    contracts.forEach(c => {
      treeEl.appendChild(createContractNode(c));
    });
    return;
  }

  if (multiAccountMode) {
    // All-accounts mode: show accounts as expandable nodes (lazy-loaded)
    const accounts = Object.entries(treeData);
    if (accounts.length === 0) {
      renderEmptyState();
      return;
    }
    accounts.forEach(([acct, val]) => {
      treeEl.appendChild(createTreeNode(acct, val, '', 0, acct));
    });
    return;
  }

  // Single-account mode: flatten top-level account wrapper
  const entries = Object.entries(treeData).flatMap(([_acct, val]) =>
    typeof val === 'object' && val !== null
      ? Object.entries(val)
      : []
  );

  if (entries.length === 0) {
    renderEmptyState();
    return;
  }

  entries.forEach(([key, val]) => {
    treeEl.appendChild(createTreeNode(key, val, key, 0));
  });

  if (lastTreeTruncated) {
    const note = document.createElement('div');
    note.className = 'tree-truncated';
    note.textContent = 'Results truncated — narrow your query or use the API for full results';
    treeEl.appendChild(note);
  }
}

function createTreeNode(name, value, path, depth, accountOverride, contractOverride) {
  const container = document.createElement('div');
  const isBranch = typeof value === 'object' && value !== null;
  const isNearAccount = name.endsWith('.near') || name.endsWith('.tg');
  let expanded = false;
  let childrenLoaded = isBranch && Object.keys(value).length > 0;
  let children = isBranch ? value : null;

  // The clickable row
  const row = document.createElement('div');
  row.className = 'tree-item';
  row.tabIndex = 0;
  row.setAttribute('role', 'treeitem');

  // Icon
  const icon = document.createElement('span');
  icon.className = 'tree-icon' + (isBranch ? '' : ' leaf');
  icon.textContent = isBranch ? '\u25b6' : '=';
  row.appendChild(icon);

  // Name
  const nameEl = document.createElement('span');
  nameEl.className = 'tree-name' + (isBranch ? ' branch' : '') + (isNearAccount ? ' near-account' : '');
  nameEl.textContent = name;
  if (isNearAccount) {
    nameEl.onclick = (e) => {
      e.stopPropagation();
      navigateToAccount(name);
    };
  }
  row.appendChild(nameEl);

  // Leaf value preview
  if (!isBranch && value !== null && value !== undefined) {
    const preview = document.createElement('span');
    preview.className = 'tree-preview';
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    preview.textContent = str.length > 60 ? str.slice(0, 60) + '...' : str;
    row.appendChild(preview);
  }

  container.appendChild(row);

  // Children container
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  childrenEl.hidden = true;
  container.appendChild(childrenEl);

  function toggle() {
    if (!isBranch) {
      selectNode(path, value);
      return;
    }
    expanded = !expanded;
    icon.textContent = expanded ? '\u25bc' : '\u25b6';
    row.setAttribute('aria-expanded', expanded);

    if (expanded && !childrenLoaded) {
      loadChildren();
    } else {
      childrenEl.hidden = !expanded;
    }
  }

  async function loadChildren() {
    icon.textContent = '...';
    try {
      const tree = await kvQueryTree(accountOverride || currentAccount, contractOverride || contractId, path || undefined);
      children = tree && typeof tree === 'object' ? tree : {};
      childrenLoaded = true;
      renderChildren();
      childrenEl.hidden = false;
    } catch (e) {
      console.error(`Failed to load children for ${path}:`, e);
      childrenEl.innerHTML = '<div class="tree-empty">failed_</div>';
      childrenEl.hidden = false;
    }
    icon.textContent = expanded ? '\u25bc' : '\u25b6';
  }

  function renderChildren() {
    childrenEl.innerHTML = '';
    const entries = Object.entries(children);
    if (entries.length === 0) {
      childrenEl.innerHTML = '<div class="tree-empty">(empty)</div>';
      return;
    }
    entries.forEach(([k, v]) => {
      childrenEl.appendChild(createTreeNode(k, v, `${path}/${k}`, depth + 1, accountOverride, contractOverride));
    });
  }

  // If branch already has children data, pre-render them
  if (isBranch && childrenLoaded) {
    renderChildren();
  }

  row.onclick = toggle;
  row.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };

  return container;
}

function createContractNode(contractName) {
  const container = document.createElement('div');
  let expanded = false;
  let childrenLoaded = false;

  const row = document.createElement('div');
  row.className = 'tree-item';
  row.tabIndex = 0;
  row.setAttribute('role', 'treeitem');

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = '\u25b6';
  row.appendChild(icon);

  const nameEl = document.createElement('span');
  nameEl.className = 'tree-name branch';
  nameEl.textContent = contractName;
  nameEl.onclick = (e) => {
    e.stopPropagation();
    if (allContractsCheck) allContractsCheck.checked = false;
    contractInput.value = contractName;
    contractInput.disabled = false;
    contractId = contractName;
    multiAccountMode = true;
    if (allAccountsCheck) allAccountsCheck.checked = true;
    accountInput.value = '';
    accountInput.disabled = true;
    currentAccount = '';
    queryInput.value = '';
    breadcrumb = [];
    explore();
  };
  row.appendChild(nameEl);

  container.appendChild(row);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  childrenEl.hidden = true;
  container.appendChild(childrenEl);

  async function toggle() {
    expanded = !expanded;
    icon.textContent = expanded ? '\u25bc' : '\u25b6';
    row.setAttribute('aria-expanded', expanded);

    if (expanded && !childrenLoaded) {
      icon.textContent = '...';
      try {
        const { accounts } = await kvAccounts(contractName, { limit: MULTI_ACCOUNT_CAP });
        childrenLoaded = true;
        childrenEl.innerHTML = '';
        if (accounts.length === 0) {
          childrenEl.innerHTML = '<div class="tree-empty">(no accounts)</div>';
        } else {
          accounts.forEach(acct => {
            childrenEl.appendChild(createAccountUnderContractNode(acct, contractName));
          });
        }
        childrenEl.hidden = false;
      } catch (e) {
        console.error(`Failed to load accounts for ${contractName}:`, e);
        childrenEl.innerHTML = '<div class="tree-empty">failed_</div>';
        childrenEl.hidden = false;
      }
      icon.textContent = expanded ? '\u25bc' : '\u25b6';
    } else {
      childrenEl.hidden = !expanded;
    }
  }

  row.onclick = toggle;
  row.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };

  return container;
}

function createAccountUnderContractNode(accountName, parentContract) {
  const container = document.createElement('div');
  let expanded = false;
  let childrenLoaded = false;

  const row = document.createElement('div');
  row.className = 'tree-item';
  row.tabIndex = 0;
  row.setAttribute('role', 'treeitem');

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = '\u25b6';
  row.appendChild(icon);

  const nameEl = document.createElement('span');
  nameEl.className = 'tree-name branch near-account';
  nameEl.textContent = accountName;
  nameEl.onclick = (e) => {
    e.stopPropagation();
    contractInput.value = parentContract;
    contractId = parentContract;
    navigateToAccount(accountName);
  };
  row.appendChild(nameEl);

  container.appendChild(row);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  childrenEl.hidden = true;
  container.appendChild(childrenEl);

  async function toggle() {
    expanded = !expanded;
    icon.textContent = expanded ? '\u25bc' : '\u25b6';
    row.setAttribute('aria-expanded', expanded);

    if (expanded && !childrenLoaded) {
      icon.textContent = '...';
      try {
        const tree = await kvQueryTree(accountName, parentContract);
        childrenLoaded = true;
        childrenEl.innerHTML = '';
        const entries = tree && typeof tree === 'object' ? Object.entries(tree) : [];
        if (entries.length === 0) {
          childrenEl.innerHTML = '<div class="tree-empty">(empty)</div>';
        } else {
          entries.forEach(([key, val]) => {
            childrenEl.appendChild(createTreeNode(key, val, key, 0, accountName, parentContract));
          });
        }
        childrenEl.hidden = false;
      } catch (e) {
        console.error(`Failed to load keys for ${accountName} on ${parentContract}:`, e);
        childrenEl.innerHTML = '<div class="tree-empty">failed_</div>';
        childrenEl.hidden = false;
      }
      icon.textContent = expanded ? '\u25bc' : '\u25b6';
    } else {
      childrenEl.hidden = !expanded;
    }
  }

  row.onclick = toggle;
  row.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };

  return container;
}

// ── Detail + History panels ─────────────────────────────────

function selectNode(path, value) {
  currentSelectedPath = path;
  detailPanel.hidden = false;
  if (historyPanel) historyPanel.hidden = false;

  // Path + copy buttons
  detailPath.innerHTML = '';
  const pathText = document.createElement('span');
  pathText.textContent = `${currentAccount}/${path}`;
  detailPath.appendChild(pathText);

  const getUrl = buildUrl('/v1/kv/get', {
    accountId: currentAccount, contractId, key: path, value_format: 'json',
  });
  const copyBar = document.createElement('div');
  copyBar.className = 'copy-bar';
  const cpUrl = document.createElement('button');
  cpUrl.className = 'copy-btn'; cpUrl.textContent = 'copy url';
  cpUrl.onclick = () => copyText(getUrl, cpUrl);
  const cpCurl = document.createElement('button');
  cpCurl.className = 'copy-btn'; cpCurl.textContent = 'copy curl';
  cpCurl.onclick = () => copyText(curlCmd(getUrl), cpCurl);
  copyBar.appendChild(cpUrl);
  copyBar.appendChild(cpCurl);
  detailPath.appendChild(copyBar);

  // Placeholder value from tree
  detailValue.textContent = tryFormatJson(value);
  detailMeta.innerHTML = '<div class="tree-loading">loading_</div>';
  if (historyList) historyList.innerHTML = '<div class="tree-loading">loading_</div>';
  if (diffResult) diffResult.textContent = '';

  // Fetch value + history in parallel
  Promise.all([
    kvGet(currentAccount, contractId, path),
    kvHistory(currentAccount, contractId, path, 50),
  ]).then(([entry, history]) => {
    // Detail panel
    if (entry) {
      detailValue.textContent = tryFormatJson(entry.value);
      renderDetailMeta(entry);
    } else {
      detailMeta.innerHTML = '';
    }
    // History panel
    currentHistoryEntries = history.entries;
    renderHistory(history.entries, history.meta);
  }).catch((e) => {
    console.error(`Failed to load detail for ${path}:`, e);
    detailMeta.innerHTML = '<div class="tree-empty">failed_</div>';
    if (historyList) historyList.innerHTML = '<div class="tree-empty">failed_</div>';
  });
}

function renderDetailMeta(entry) {
  let html = '';
  if (entry.blockHeight != null) {
    html += `<div><span class="meta-label">block: </span><span class="meta-value">${esc(String(entry.blockHeight))}</span></div>`;
  }
  if (entry.txHash) {
    html += `<div><span class="meta-label">tx: </span><a href="${EXPLORER_URL}/${encodeURIComponent(entry.txHash)}" target="_blank" rel="noopener noreferrer">${esc(entry.txHash.slice(0, 12))}...</a></div>`;
  }
  if (entry.receiptId) {
    html += `<div><span class="meta-label">receipt: </span><span class="meta-value">${esc(entry.receiptId.slice(0, 12))}...</span></div>`;
  }
  if (entry.accountId) {
    html += `<div><span class="meta-label">writer: </span><span class="meta-writer">${esc(entry.accountId)}</span></div>`;
  }
  if (entry.isDeleted) {
    html += `<div><span class="meta-label">deleted: </span><span style="color:var(--danger)">true</span></div>`;
  }
  detailMeta.innerHTML = html;
}

function renderHistory(entries, meta) {
  if (!historyList) return;
  historyList.innerHTML = '';
  if (diffSelectA) diffSelectA.innerHTML = '';
  if (diffSelectB) diffSelectB.innerHTML = '';

  if (entries.length === 0) {
    historyList.innerHTML = '<div class="tree-empty">no history</div>';
    return;
  }

  // Populate diff selects
  entries.forEach((e) => {
    if (diffSelectA) {
      const opt = document.createElement('option');
      opt.value = e.blockHeight;
      opt.textContent = `#${e.blockHeight}`;
      diffSelectA.appendChild(opt);
    }
    if (diffSelectB) {
      const opt = document.createElement('option');
      opt.value = e.blockHeight;
      opt.textContent = `#${e.blockHeight}`;
      diffSelectB.appendChild(opt);
    }
  });
  // Default A = 2nd-newest, B = newest
  if (entries.length >= 2 && diffSelectA) diffSelectA.selectedIndex = 1;

  // Render version list
  entries.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'history-row';

    const block = document.createElement('span');
    block.className = 'history-block';
    block.textContent = `#${e.blockHeight}`;
    row.appendChild(block);

    if (e.isDeleted) {
      const del = document.createElement('span');
      del.className = 'history-deleted';
      del.textContent = 'deleted';
      row.appendChild(del);
    }

    const preview = document.createElement('span');
    preview.className = 'history-preview';
    const val = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
    preview.textContent = val.length > 40 ? val.slice(0, 40) + '...' : val;
    row.appendChild(preview);

    row.onclick = () => {
      detailValue.textContent = tryFormatJson(e.value);
      renderDetailMeta(e);
    };

    historyList.appendChild(row);
  });

  if (meta && meta.has_more) {
    const more = document.createElement('div');
    more.className = 'tree-empty';
    more.textContent = '+ more versions...';
    historyList.appendChild(more);
  }

  // History copy bar
  const hUrl = buildUrl('/v1/kv/history', {
    accountId: currentAccount, contractId, key: currentSelectedPath,
    value_format: 'json', order: 'desc', limit: '50',
  });
  const hBar = historyList.parentElement.querySelector('.history-copy-bar');
  if (hBar) {
    hBar.innerHTML = '';
    const cpU = document.createElement('button');
    cpU.className = 'copy-btn'; cpU.textContent = 'copy url';
    cpU.onclick = () => copyText(hUrl, cpU);
    const cpC = document.createElement('button');
    cpC.className = 'copy-btn'; cpC.textContent = 'copy curl';
    cpC.onclick = () => copyText(curlCmd(hUrl), cpC);
    hBar.appendChild(cpU);
    hBar.appendChild(cpC);
  }
}

function hideDetail() {
  detailPanel.hidden = true;
  if (historyPanel) historyPanel.hidden = true;
  currentSelectedPath = null;
  currentHistoryEntries = [];
}

// ── Feed / Timeline ────────────────────────────────────────

async function loadFeed(accountId) {
  if (!feedList) return;
  feedList.innerHTML = '<div class="tree-loading">loading_</div>';

  try {
    const result = await kvTimeline(accountId, contractId, 20);
    const items = result.data || result || [];

    if (items.length === 0) {
      feedList.innerHTML = '<div class="tree-empty">no recent activity</div>';
      return;
    }

    feedList.innerHTML = '';
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'feed-item';
      div.onclick = () => feedNavigate(accountId, item.key || '');

      const header = document.createElement('div');
      header.className = 'feed-item-header';
      const keySpan = document.createElement('span');
      keySpan.className = 'feed-item-key';
      keySpan.textContent = item.key || '';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'feed-item-time';
      timeSpan.textContent = item.blockTimestamp
        ? timeAgo(Math.floor(Number(item.blockTimestamp) / 1e6)) : '';
      header.appendChild(keySpan);
      header.appendChild(timeSpan);
      div.appendChild(header);

      const valDiv = document.createElement('div');
      valDiv.className = 'feed-item-value';
      const raw = typeof item.value === 'string' ? item.value : JSON.stringify(item.value || '');
      valDiv.textContent = raw.length > 80 ? raw.slice(0, 80) + '...' : raw;
      div.appendChild(valDiv);

      const blockDiv = document.createElement('div');
      blockDiv.className = 'feed-item-block';
      blockDiv.textContent = `block ${item.blockHeight || ''}`;
      div.appendChild(blockDiv);

      feedList.appendChild(div);
    });
  } catch (e) {
    feedList.innerHTML = '<div class="tree-empty">failed to load feed</div>';
    console.error(e);
  }
}

function feedNavigate(accountId, key) {
  setAccount(accountId);
  const parts = key.split('/');
  breadcrumb = [accountId, ...parts];
  queryInput.value = `${key}/**`;
  setViewMode('tree');
  explore(`${key}/**`);
}

function timeAgo(timestampMs) {
  const diff = Date.now() - timestampMs;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ── Navigation ──────────────────────────────────────────────

function navigateToAccount(accountId) {
  setAccount(accountId);
  queryInput.value = '';
  breadcrumb = [currentAccount];
  explore();
}

// ── View mode ───────────────────────────────────────────────

const viewWriteBtn = $('#view-write');
const writePanel = $('#write-panel');

function setViewMode(mode) {
  viewMode = mode;
  viewTreeBtn.classList.toggle('active', mode === 'tree');
  viewJsonBtn.classList.toggle('active', mode === 'json');
  if (viewWriteBtn) {
    viewWriteBtn.classList.toggle('active', mode === 'write');
    viewWriteBtn.setAttribute('aria-pressed', mode === 'write');
  }
  viewTreeBtn.setAttribute('aria-pressed', mode === 'tree');
  viewJsonBtn.setAttribute('aria-pressed', mode === 'json');
  render();
  pushHash();
}

// ── Render ──────────────────────────────────────────────────

function render() {
  renderBreadcrumb();

  // Hide all panels first
  contentEl.hidden = true;
  jsonPanel.hidden = true;
  if (writePanel) writePanel.hidden = true;
  if (feedPanel) feedPanel.hidden = true;

  if (viewMode === 'write') {
    if (writePanel) writePanel.hidden = false;
  } else if (viewMode === 'json') {
    jsonPanel.hidden = false;
    jsonView.textContent = loading ? 'loading...' : rawData ? JSON.stringify(rawData, null, 2) : 'no data';
  } else if (viewMode === 'feed') {
    if (feedPanel) feedPanel.hidden = false;
  } else {
    contentEl.hidden = false;
    renderTree();
  }
}

// ── Event listeners ─────────────────────────────────────────

exploreForm.onsubmit = (e) => {
  e.preventDefault();
  const q = queryInput.value.trim();
  const isMulti = allAccountsCheck && allAccountsCheck.checked;
  currentAccount = isMulti ? '' : (accountInput.value.trim() || '');
  if (q) {
    const keyParts = q.replace(/\/?\*+$/, '').split('/');
    breadcrumb = currentAccount ? [currentAccount, ...keyParts] : keyParts;
    explore(q);
  } else {
    breadcrumb = currentAccount ? [currentAccount] : [];
    explore();
  }
};

retryBtn.onclick = () => explore();

viewTreeBtn.onclick = () => setViewMode('tree');
viewJsonBtn.onclick = () => setViewMode('json');
if (viewWriteBtn) viewWriteBtn.onclick = () => { if (!viewWriteBtn.disabled) setViewMode('write'); };

contractInput.onchange = () => {
  contractId = contractInput.value;
  if (typeof checkContractMismatch === 'function') checkContractMismatch();
  pushHash();
};

accountInput.onchange = () => {
  currentAccount = accountInput.value;
};

if (allContractsCheck) {
  allContractsCheck.onchange = () => {
    contractInput.disabled = allContractsCheck.checked;
  };
}

if (allAccountsCheck) {
  allAccountsCheck.onchange = () => {
    accountInput.disabled = allAccountsCheck.checked;
  };
}

function setAccount(accountId) {
  currentAccount = accountId;
  multiAccountMode = false;
  if (accountInput) { accountInput.value = accountId; accountInput.disabled = false; }
  if (allAccountsCheck) allAccountsCheck.checked = false;
}

// Diff button handler
if (diffBtn) {
  diffBtn.onclick = async () => {
    const blockA = parseInt(diffSelectA.value, 10);
    const blockB = parseInt(diffSelectB.value, 10);
    if (isNaN(blockA) || isNaN(blockB) || !currentSelectedPath) return;

    diffBtn.disabled = true;
    diffBtn.textContent = '...';
    diffResult.textContent = 'loading diff...';

    try {
      const diff = await kvDiff(currentAccount, contractId, currentSelectedPath, blockA, blockB);
      const aVal = diff.a ? tryFormatJson(diff.a.value) : '(not found)';
      const bVal = diff.b ? tryFormatJson(diff.b.value) : '(not found)';
      diffResult.textContent = `\u2500\u2500 block #${blockA} \u2500\u2500\n${aVal}\n\n\u2500\u2500 block #${blockB} \u2500\u2500\n${bVal}`;

      // Diff copy buttons
      if (diffCopyBar) {
        diffCopyBar.innerHTML = '';
        const dUrl = buildUrl('/v1/kv/diff', {
          accountId: currentAccount, contractId,
          key: currentSelectedPath,
          block_height_a: blockA, block_height_b: blockB,
          value_format: 'json',
        });
        const cpU = document.createElement('button');
        cpU.className = 'copy-btn'; cpU.textContent = 'copy url';
        cpU.onclick = () => copyText(dUrl, cpU);
        const cpC = document.createElement('button');
        cpC.className = 'copy-btn'; cpC.textContent = 'copy curl';
        cpC.onclick = () => copyText(curlCmd(dUrl), cpC);
        diffCopyBar.appendChild(cpU);
        diffCopyBar.appendChild(cpC);
      }
    } catch (e) {
      console.error('Diff failed:', e);
      diffResult.textContent = 'diff failed';
    }

    diffBtn.disabled = false;
    diffBtn.textContent = 'diff';
  };
}

// ── Init ────────────────────────────────────────────────────

window.addEventListener('hashchange', () => {
  if (hashPushing) return;
  readHash();
});

currentAccount = accountInput.value.trim();
breadcrumb = currentAccount ? [currentAccount] : [];

document.getElementById('inspector-toggle').addEventListener('click', toggleInspector);
document.getElementById('inspector-copy').addEventListener('click', function(e) {
  e.stopPropagation();
  copyAsCurl();
});
// readHash() + explore() called from wallet.js module after it loads
