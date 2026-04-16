// ============================================================
// Study Repository — Shared App v2.0
// ============================================================
// This file is IDENTICAL across all repos (SL1, COMMDIS1A, ASTRO, HS19…).
// Repo-specific values come from config.js which must load BEFORE this file.
// To add a feature: edit this file, then push to every repo (use deploy.ps1).
// ============================================================

// Guard: ensure config loaded
if (!window.REPO_CONFIG) {
  throw new Error('[app.js] window.REPO_CONFIG not found. Ensure config.js loads before app.js.');
}
const CFG = window.REPO_CONFIG;

// Set page title from config
document.title = CFG.appName;
document.addEventListener('DOMContentLoaded', function() {
  // Set header text from config
  const h1 = document.querySelector('.header-brand h1');
  const subtitle = document.querySelector('.header-brand .subtitle');
  if (h1) h1.textContent = CFG.appName;
  if (subtitle) subtitle.textContent = CFG.course;
  // Apply per-repo accent color
  if (CFG.accentColor) {
    const r = document.documentElement;
    r.style.setProperty('--accent',       CFG.accentColor);
    r.style.setProperty('--accent-light', CFG.accentColorLight || CFG.accentColor);
    r.style.setProperty('--tag-bg',       CFG.accentColorBg  || '#e4eaff');
    r.style.setProperty('--tag-text',     CFG.accentColorTag || CFG.accentColor);
  }
});



// ============================================================
// DATA STORE — separate localStorage key from SLP repo
// ============================================================
let db = {
  meta: { name: CFG.appName, course: CFG.course, created: new Date().toISOString() },
  modules: [],
  glossary: [],
  flashcards: [],
  questions: [],
  notes: []
};

// storageKey is now CFG.storageKey (see config.js)

// ============================================================
// GITHUB-BACKED STORAGE
// ============================================================
let ghSettings = null;      // { username, repo, pat, branch }
let saveTimer = null;       // debounce handle
let lastSavedSha = null;    // SHA of data.json on GitHub (needed for updates)
let syncPending = false;    // true while a save is in flight

function loadGhSettings() {
  try {
    const raw = localStorage.getItem(CFG.settingsKey);
    if (raw) ghSettings = JSON.parse(raw);
  } catch(e) { ghSettings = null; }
}

function saveGhSettings() {
  try { localStorage.setItem(CFG.settingsKey, JSON.stringify(ghSettings)); } catch(e) {}
}

function ghConfigured() {
  return ghSettings && ghSettings.username && ghSettings.repo && ghSettings.pat;
}

// ── Sync status indicator in header ─────────────────────────────────────────
function setSyncStatus(state, msg) {
  const el = document.getElementById('syncIndicator');
  if (!el) return;
  el.className = 'sync-indicator ' + state;
  const dot = el.querySelector('.sync-dot');
  const txt = el.querySelector('.sync-label');
  if (txt) txt.textContent = msg || { idle:'GitHub sync', saving:'Saving…', saved:'Saved', error:'Sync error', local:'Local only' }[state] || msg;
  if (state === 'error' || state === 'local' || state === 'nopat') el.onclick = () => showPage('manage');
  else el.onclick = null;
}

// ── Save (localStorage cache always; GitHub if configured) ──────────────────
function save() {
  // Always write to localStorage as instant cache
  try { localStorage.setItem(CFG.storageKey, JSON.stringify(db)); } catch(e) {}
  // Debounce GitHub write by 1.5s to batch rapid changes
  if (ghConfigured()) {
    clearTimeout(saveTimer);
    setSyncStatus('saving');
    saveTimer = setTimeout(pushToGitHub, 1500);
  }
}

async function pushToGitHub() {
  if (!ghConfigured()) return;
  syncPending = true;
  const { username, repo, pat, branch } = ghSettings;
  const b = branch || 'main';
  const base = `https://api.github.com/repos/${username}/${repo}`;
  const headers = {
    Authorization: `token ${pat}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };
  const jsonStr = JSON.stringify(db, null, 2);

  try {
    // Step 1: Create a blob (supports files of any size — no 1MB limit)
    const blobRes = await fetch(`${base}/git/blobs`, {
      method: 'POST', headers,
      body: JSON.stringify({ content: jsonStr, encoding: 'utf-8' })
    });
    if (!blobRes.ok) throw new Error(`Blob creation failed: ${blobRes.status}`);
    const blob = await blobRes.json();

    // Step 2: Get the current HEAD commit SHA for the branch
    const refRes = await fetch(`${base}/git/ref/heads/${b}`, { headers });
    if (!refRes.ok) throw new Error(`Ref fetch failed: ${refRes.status}`);
    const ref = await refRes.json();
    const latestCommitSha = ref.object.sha;

    // Step 3: Get the tree SHA from that commit
    const commitRes = await fetch(`${base}/git/commits/${latestCommitSha}`, { headers });
    if (!commitRes.ok) throw new Error(`Commit fetch failed: ${commitRes.status}`);
    const commit = await commitRes.json();
    const baseTreeSha = commit.tree.sha;

    // Step 4: Create a new tree with the updated file
    const treeRes = await fetch(`${base}/git/trees`, {
      method: 'POST', headers,
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: [{ path: CFG.dataFile, mode: '100644', type: 'blob', sha: blob.sha }]
      })
    });
    if (!treeRes.ok) throw new Error(`Tree creation failed: ${treeRes.status}`);
    const tree = await treeRes.json();

    // Step 5: Create a new commit
    const newCommitRes = await fetch(`${base}/git/commits`, {
      method: 'POST', headers,
      body: JSON.stringify({
        message: `Auto-save ${CFG.dataFile}`,
        tree: tree.sha,
        parents: [latestCommitSha]
      })
    });
    if (!newCommitRes.ok) throw new Error(`Commit creation failed: ${newCommitRes.status}`);
    const newCommit = await newCommitRes.json();

    // Step 6: Update the branch ref to point to the new commit
    const updateRefRes = await fetch(`${base}/git/refs/heads/${b}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ sha: newCommit.sha })
    });
    if (!updateRefRes.ok) throw new Error(`Ref update failed: ${updateRefRes.status}`);

    lastSavedSha = newCommit.sha;
    setSyncStatus('saved');
    setTimeout(() => setSyncStatus('idle'), 3000);
  } catch(e) {
    console.error('GitHub push error:', e);
    setSyncStatus('error', 'Sync error — click to fix');
  }
  syncPending = false;
}

// ── Load: try GitHub first, fall back to localStorage cache ─────────────────
async function load() {
  loadGhSettings();

  // ── Step 1: Load localStorage cache immediately (instant UI) ────────────
  try {
    const d = localStorage.getItem(CFG.storageKey);
    if (d) db = JSON.parse(d);
  } catch(e) {}

  // ── Step 2: Always try GitHub (public repos = no PAT needed for reads) ──
  // This is the cross-device fix: even on a brand-new device with empty
  // localStorage, we pull the latest data from the public GitHub repo.
  // PAT is only required for WRITES (pushToGitHub).
  const owner  = (ghConfigured() ? ghSettings.username : null) || CFG.owner;
  const repo   = (ghConfigured() ? ghSettings.repo     : null) || CFG.repoName;
  const branch = (ghConfigured() ? ghSettings.branch   : null) || 'main';

  if (owner && repo) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${CFG.dataFile}`;
    const headers = {};  // public repo — no auth on reads (avoids CORS preflight)

    setSyncStatus('saving', 'Loading…');
    try {
      const res = await fetch(rawUrl, { headers, cache: 'no-store' });
      if (res.ok) {
        const remote = await res.json();
        // Only overwrite local if remote is newer (or local is empty)
        const localTime  = db?.meta?.lastSave  ? new Date(db.meta.lastSave).getTime()     : 0;
        const remoteTime = remote?.meta?.lastSave ? new Date(remote.meta.lastSave).getTime() : 0;
        if (!localTime || remoteTime >= localTime) {
          db = remote;
          try { localStorage.setItem(CFG.storageKey, JSON.stringify(db)); } catch(e) {}
        }
        if (ghConfigured()) {
          setSyncStatus('saved', 'Synced');
        } else {
          setSyncStatus('local', 'Loaded — add PAT to enable saving');
        }
        setTimeout(() => setSyncStatus('idle'), 3000);
        return;
      } else if (res.status === 404 && ghConfigured()) {
        // File doesn't exist on GitHub yet — first-time push
        setSyncStatus('saving', 'First sync…');
        await pushToGitHub();
        return;
      }
      // Non-404 error fall through to local-only
    } catch(e) {
      console.warn('GitHub load failed, using local cache:', e);
    }
  }

  // ── Step 3: Fallback — use whatever is in localStorage ──────────────────
  setSyncStatus(ghConfigured() ? 'error' : 'local',
                ghConfigured() ? 'Sync error — click to fix' : 'Local only');
}


// ── GitHub Settings UI ───────────────────────────────────────────────────────
function renderGhSettings() {
  const s = ghSettings || {};
  const configured = ghConfigured();
  const el = document.getElementById('ghSettingsContent');
  if (!el) return;

  const statusBar = configured
    ? `<div class="gh-status-bar connected">✅ Connected to <strong>${s.username}/${s.repo}</strong> — data file: <code>${CFG.dataFile}</code> on branch <strong>${s.branch || 'main'}</strong></div>`
    : `<div class="gh-status-bar disconnected">⚠️ Not configured — data is stored locally in this browser only.<br>Enter your GitHub details below to enable cross-device sync and saving.</div>`;

  el.innerHTML = `
    ${statusBar}
    <div class="gh-row">
      <div>
        <label>GitHub Username</label>
        <input type="text" id="gh_username" value="${escHtml(s.username||'')}" placeholder="your-github-username" autocomplete="off">
      </div>
      <div>
        <label>Repository Name</label>
        <input type="text" id="gh_repo" value="${escHtml(s.repo||'')}" placeholder="your-repo-name" autocomplete="off">
      </div>
    </div>
    <div class="gh-row">
      <div>
        <label>Branch</label>
        <input type="text" id="gh_branch" value="${escHtml(s.branch||'main')}" placeholder="main" autocomplete="off">
      </div>
      <div>
        <label>Data Filename</label>
        <input type="text" id="gh_filename" value=CFG.dataFile disabled style="opacity:0.5;cursor:not-allowed">
      </div>
    </div>
    <div class="gh-row full">
      <div>
        <label>Personal Access Token (PAT) — stored in this browser only</label>
        <input type="password" id="gh_pat" value="${escHtml(s.pat||'')}" placeholder="github_pat_xxxxxxxxxxxx…" autocomplete="new-password">
      </div>
    </div>
    <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6">
      Create a fine-grained PAT at <strong>github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens</strong>.
      Set <em>Repository access</em> to this repo only and enable <em>Contents: Read and write</em>.
    </div>
    <div class="gh-actions">
      <button class="btn btn-primary" onclick="saveGhSettingsFromUI()">💾 Save & Connect</button>
      ${configured ? `<button class="btn" onclick="testGhConnection()" style="background:var(--surface-2)">🔍 Test Connection</button>
      <button class="btn" onclick="forcePushToGitHub()" style="background:var(--surface-2)">⬆ Push Local Data Now</button>
      <button class="btn" onclick="disconnectGitHub()" style="background:#fff0f0;color:var(--danger);border-color:#f5c6c6">Disconnect</button>` : ''}
    </div>`;
}

function saveGhSettingsFromUI() {
  const username = document.getElementById('gh_username')?.value.trim();
  const repo = document.getElementById('gh_repo')?.value.trim();
  const pat = document.getElementById('gh_pat')?.value.trim();
  const branch = document.getElementById('gh_branch')?.value.trim() || 'main';
  if (!username || !repo || !pat) { alert('Please fill in username, repository name, and PAT.'); return; }
  ghSettings = { username, repo, pat, branch };
  saveGhSettings();
  lastSavedSha = null;  // reset so we fetch fresh SHA
  renderGhSettings();
  setSyncStatus('saving', 'Connecting…');
  pushToGitHub().then(() => renderGhSettings());
}

async function testGhConnection() {
  if (!ghConfigured()) { alert('Not configured yet.'); return; }
  const { username, repo, pat } = ghSettings;
  try {
    const res = await fetch(`https://api.github.com/repos/${username}/${repo}`, {
      headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (res.ok) {
      const data = await res.json();
      alert(`✅ Connection successful!\n\nRepository: ${data.full_name}\nVisibility: ${data.private ? 'Private' : 'Public'}\nDefault branch: ${data.default_branch}`);
    } else {
      const err = await res.json();
      alert(`❌ Connection failed (${res.status}):\n${err.message}\n\nCheck your username, repo name, and PAT.`);
    }
  } catch(e) {
    alert('❌ Network error: ' + e.message);
  }
}

async function forcePushToGitHub() {
  if (!confirm('Push your current local data to GitHub now? This will overwrite whatever is in sl1_data.json.')) return;
  lastSavedSha = null;
  setSyncStatus('saving');
  await pushToGitHub();
  alert('✓ Data pushed to GitHub.');
}

function disconnectGitHub() {
  if (!confirm('Disconnect from GitHub? Your data stays in this browser but will no longer sync.')) return;
  ghSettings = null;
  lastSavedSha = null;
  localStorage.removeItem(CFG.settingsKey);
  renderGhSettings();
  setSyncStatus('local');
}


function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ============================================================
// NAVIGATION
// ============================================================
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(i => {
    if (i.getAttribute('onclick') && i.getAttribute('onclick').includes(name)) i.classList.add('active');
  });
  if (name === 'dashboard') renderDashboard();
  if (name === 'flashcards') renderFlashcards();
  if (name === 'glossary') renderGlossary();
  if (name === 'quiz') renderQuizSetup();
  if (name === 'notes') renderNotes();
  if (name === 'manage') renderManage();
  if (name === 'module') { /* rendered by showModuleDetail */ }
  if (name === 'search') {
    const input = document.getElementById('searchPageInput');
    if (input) setTimeout(() => input.focus(), 50);
  }
}

// ============================================================
// MODALS
// ============================================================
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function openAddModule() { openModal('modal-module'); document.getElementById('modName').value=''; document.getElementById('modDesc').value=''; }
function openAddTerm() { populateModuleSelects(); openModal('modal-term'); }
function openAddFlashcard() { populateModuleSelects(); openModal('modal-flashcard'); }
function openAddQuestion() { populateModuleSelects(); updateQuestionForm(); openModal('modal-question'); }

function populateModuleSelects() {
  const opts = '<option value="">— No Module —</option>' + db.modules.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  ['termModule','fcModule','qModule','noteModuleSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
}

// ============================================================
// MODULES
// ============================================================
function saveModule() {
  const name = document.getElementById('modName').value.trim();
  if (!name) return alert('Please enter a module name.');
  db.modules.push({ id: uid(), name, desc: document.getElementById('modDesc').value.trim(), created: new Date().toISOString() });
  save(); closeModal('modal-module'); renderDashboard(); updateBadges();
}

// ============================================================
// GLOSSARY
// ============================================================
function saveTerm() {
  const term = document.getElementById('termName').value.trim();
  const def = document.getElementById('termDef').value.trim();
  if (!term || !def) return alert('Term and definition are required.');
  db.glossary.push({
    id: uid(), term, def,
    module: document.getElementById('termModule').value,
    chapter: document.getElementById('termChapter').value.trim(),
    source: document.getElementById('termSource').value.trim(),
    created: new Date().toISOString()
  });
  db.glossary.sort((a,b) => a.term.localeCompare(b.term));
  save(); closeModal('modal-term'); renderGlossary(); updateBadges();
}

function renderGlossary() {
  const q = (document.getElementById('glossarySearch')?.value || '').toLowerCase();
  let items = db.glossary.filter(t => !q || t.term.toLowerCase().includes(q) || t.def.toLowerCase().includes(q));
  const content = document.getElementById('glossaryContent');
  const alphaEl = document.getElementById('alphaIndex');
  updateBadges();

  if (!items.length) {
    content.innerHTML = `<div class="empty-state"><div class="icon">📖</div><p>${q ? 'No terms match your search.' : 'Your glossary is empty. Add your first term!'}</p>${!q?'<button class="btn btn-primary" onclick="openAddTerm()">Add Term</button>':''}</div>`;
    alphaEl.innerHTML = '';
    return;
  }

  const letters = [...new Set(items.map(t => t.term[0].toUpperCase()))].sort();
  const allLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  alphaEl.innerHTML = allLetters.map(l => {
    const has = letters.includes(l);
    return `<div class="alpha-btn${has?' has-entries':''}" onclick="scrollToLetter('${l}')">${l}</div>`;
  }).join('');

  const groups = {};
  items.forEach(t => {
    const l = t.term[0].toUpperCase();
    if (!groups[l]) groups[l] = [];
    groups[l].push(t);
  });

  content.innerHTML = letters.map(l => `
    <div class="glossary-letter-group" id="letter-${l}">
      <div class="glossary-letter-heading">${l}</div>
      ${groups[l].map(t => `
        <div class="glossary-entry">
          ${t.image ? `<img class="sign-img-thumb" src="${t.image}" alt="${escHtml(t.term)}" loading="lazy">` : '<div></div>'}
          <div>
          <div class="glossary-term">${t.term}</div>
          <div class="glossary-def">${t.def}</div>
          </div>
          <div style="display:flex;gap:0.4rem;align-items:center;flex-direction:column">
            ${t.source ? `<button class="source-btn" onmouseenter="showTooltip(event,'Source: ${escHtml(t.source)}')" onmouseleave="hideTooltip()">src</button>` : ''}
            ${t.chapter ? `<span class="tag neutral" style="font-size:0.68rem">${escHtml(t.chapter)}</span>` : (t.module ? `<span class="tag neutral" style="font-size:0.68rem">${escHtml(getModuleName(t.module))}</span>` : '')}
            <button class="source-btn" style="color:var(--danger);border-color:var(--danger)" onclick="deleteTerm('${t.id}')">✕</button>
          </div>
        </div>`).join('')}
    </div>`).join('');
}

function deleteTerm(id) {
  if (!confirm('Delete this term?')) return;
  db.glossary = db.glossary.filter(t => t.id !== id);
  save(); renderGlossary();
}

function scrollToLetter(l) {
  const el = document.getElementById('letter-' + l);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================
// FLASHCARDS
// ============================================================
let fcFiltered = [], fcIndex = 0;

function saveFlashcard() {
  const front = document.getElementById('fcFront').value.trim();
  const back = document.getElementById('fcBack').value.trim();
  if (!front || !back) return alert('Front and back are required.');
  db.flashcards.push({
    id: uid(), front, back,
    module: document.getElementById('fcModule').value,
    source: document.getElementById('fcSource').value.trim(),
    created: new Date().toISOString()
  });
  save(); closeModal('modal-flashcard'); renderFlashcards(); updateBadges();
}

function renderFlashcards() {
  const filterBar = document.getElementById('fcFilterBar');
  const content = document.getElementById('fcContent');
  updateBadges();

  if (!db.flashcards.length) {
    filterBar.innerHTML = '';
    content.innerHTML = `<div class="empty-state"><div class="icon">🃏</div><p>No flashcards yet. Add some to begin studying!</p><button class="btn btn-primary" onclick="openAddFlashcard()">Add Flashcard</button></div>`;
    return;
  }

  const activeFilter = document.querySelector('.filter-chip.active')?.dataset.module || 'all';
  filterBar.innerHTML = `
    <div class="filter-chip${activeFilter==='all'?' active':''}" data-module="all" onclick="setFcFilter('all')">All</div>
    ${db.modules.filter(m => db.flashcards.some(f => f.module === m.id)).map(m =>
      `<div class="filter-chip${activeFilter===m.id?' active':''}" data-module="${m.id}" onclick="setFcFilter('${m.id}')">${escHtml(m.name)}</div>`
    ).join('')}
    <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="openAddFlashcard()">+ Add</button>`;

  fcFiltered = activeFilter === 'all' ? db.flashcards : db.flashcards.filter(f => f.module === activeFilter);
  if (!fcFiltered.length) { content.innerHTML = `<div class="empty-state"><p>No flashcards for this module.</p></div>`; return; }
  fcIndex = Math.min(fcIndex, fcFiltered.length - 1);
  renderCurrentCard();
}

function setFcFilter(mod) {
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.module === mod));
  fcFiltered = mod === 'all' ? db.flashcards : db.flashcards.filter(f => f.module === mod);
  fcIndex = 0;
  renderCurrentCard();
}

function renderCurrentCard() {
  const content = document.getElementById('fcContent');
  if (!fcFiltered.length) return;
  const card = fcFiltered[fcIndex];
  const modName = card.module ? getModuleName(card.module) : '';
  content.innerHTML = `
    <div class="fc-module-info">
      ${modName ? `<span class="tag">${escHtml(modName)}</span>` : ''}
      ${card.source ? `<button class="source-btn" style="margin-left:0.5rem" onmouseenter="showTooltip(event,'Source: ${escHtml(card.source)}')" onmouseleave="hideTooltip()">src</button>` : ''}
    </div>
    <div class="flashcard-scene" id="currentCard" onclick="flipCard()">
      <div class="flashcard-inner">
        <div class="flashcard-front">
          <div class="flashcard-label">Term / Question</div>
          ${card.image ? `<img class="sign-img-card" src="${card.image}" alt="sign illustration" loading="lazy">` : ''}
          <div class="flashcard-term">${escHtml(card.front)}</div>
          <div class="flashcard-hint">Click to reveal</div>
        </div>
        <div class="flashcard-back">
          <div class="flashcard-label" style="color:var(--text-light)">Definition / Answer</div>
          <div class="flashcard-def">${escHtml(card.back)}</div>
        </div>
      </div>
    </div>
    <div class="fc-controls">
      <button class="btn btn-secondary" onclick="fcNav(-1)">← Prev</button>
      <span class="fc-counter">${fcIndex+1} / ${fcFiltered.length}</span>
      <button class="btn btn-secondary" onclick="fcNav(1)">Next →</button>
    </div>
    <div style="text-align:center;margin-top:0.5rem">
      <button class="btn btn-secondary btn-sm" onclick="shuffleCards()">🔀 Shuffle</button>
      <button class="btn btn-secondary btn-sm" style="margin-left:0.5rem;color:var(--danger)" onclick="deleteCard('${card.id}')">Delete</button>
    </div>`;
}

function flipCard() { document.getElementById('currentCard')?.classList.toggle('flipped'); }
function fcNav(dir) { fcIndex = (fcIndex + dir + fcFiltered.length) % fcFiltered.length; renderCurrentCard(); }
function shuffleCards() { fcFiltered = fcFiltered.sort(() => Math.random()-0.5); fcIndex = 0; renderCurrentCard(); }
function deleteCard(id) { if (!confirm('Delete this flashcard?')) return; db.flashcards = db.flashcards.filter(f => f.id!==id); save(); renderFlashcards(); }

document.addEventListener('keydown', e => {
  if (document.getElementById('page-flashcards').classList.contains('active')) {
    if (e.key === 'ArrowLeft') fcNav(-1);
    if (e.key === 'ArrowRight') fcNav(1);
    if (e.key === ' ') { e.preventDefault(); flipCard(); }
  }
});

// ============================================================
// QUIZ
// ============================================================
let quizState = { questions: [], index: 0, answers: [], score: 0, matchSelected: null };

function renderQuizSetup() {
  const qc = document.getElementById('quizContent');
  if (!db.questions.length) {
    qc.innerHTML = `<div class="empty-state"><div class="icon">❓</div><p>No questions yet. Add some quiz questions to get started!</p><button class="btn btn-primary" onclick="openAddQuestion()">Add Question</button></div>`;
    return;
  }
  const modOpts = '<option value="all">All Modules</option>' + db.modules.map(m => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
  qc.innerHTML = `
    <div class="quiz-setup">
      <div class="quiz-form-group"><label>Module / Week</label><select id="quizModFilter">${modOpts}</select></div>
      <div class="quiz-form-group"><label>Number of Questions</label><input type="number" id="quizCount" value="10" min="1" max="50"></div>
      <div class="quiz-form-group">
        <label>Question Types</label>
        <div class="quiz-type-grid">
          ${[['mc','Multiple Choice'],['tf','True / False'],['fitb','Fill in the Blank'],['match','Matching'],['sa','Short Answer']].map(([v,l]) =>
            `<label class="quiz-type-option"><input type="checkbox" value="${v}" checked class="qtypecheck"> ${l}</label>`
          ).join('')}
        </div>
      </div>
      <button class="btn btn-primary" onclick="startQuiz()">Start Quiz →</button>
      <button class="btn btn-secondary" style="margin-left:0.75rem" onclick="openAddQuestion()">+ Add Question</button>
    </div>`;
}

function startQuiz() {
  const mod = document.getElementById('quizModFilter').value;
  const count = parseInt(document.getElementById('quizCount').value) || 10;
  const types = [...document.querySelectorAll('.qtypecheck:checked')].map(c => c.value);
  if (!types.length) return alert('Select at least one question type.');
  let pool = db.questions.filter(q => (mod==='all' || q.module===mod) && types.includes(q.type));
  if (!pool.length) return alert('No questions match your filters.');
  pool = pool.sort(() => Math.random()-0.5).slice(0, Math.min(count, pool.length));
  quizState = { questions: pool, index: 0, answers: [], score: 0, matchSelected: null };
  renderQuestion();
}

function renderQuestion() {
  const qc = document.getElementById('quizContent');
  const { questions, index } = quizState;
  if (index >= questions.length) { renderResults(); return; }
  const q = questions[index];
  const prog = ((index / questions.length) * 100).toFixed(0);
  const typeLabels = { mc:'Multiple Choice', tf:'True / False', fitb:'Fill in the Blank', match:'Matching', sa:'Short Answer' };

  let answerHTML = '';
  if (q.type === 'mc') {
    const opts = q.options || [q.answer, 'Option B', 'Option C', 'Option D'];
    answerHTML = opts.map((o,i) => `<div class="mc-option" id="mco-${i}" onclick="selectMC(${i})"><div class="option-letter">${'ABCD'[i]}</div><div>${escHtml(o)}</div></div>`).join('');
  } else if (q.type === 'tf') {
    answerHTML = `<div class="tf-options"><button class="tf-btn" id="tf-true" onclick="selectTF('true')">True</button><button class="tf-btn" id="tf-false" onclick="selectTF('false')">False</button></div>`;
  } else if (q.type === 'fitb') {
    answerHTML = `<div>Complete the statement: <input class="fitb-input" id="fitbInput" placeholder="your answer…" onkeydown="if(event.key==='Enter')checkFITB()"> <button class="btn btn-secondary btn-sm" style="margin-left:0.5rem" onclick="checkFITB()">Check</button></div>`;
  } else if (q.type === 'match') {
    const pairs = q.pairs || [[q.answer,'Answer']];
    const shuffledRight = [...pairs].sort(() => Math.random()-0.5);
    answerHTML = `<div class="match-grid">
      <div><div class="match-col-label">Terms</div>${pairs.map((p,i)=>`<div class="match-item" id="ml-${i}" onclick="selectMatchLeft(${i},'${escHtml(p[0])}')">${escHtml(p[0])}</div>`).join('')}</div>
      <div><div class="match-col-label">Definitions</div>${shuffledRight.map((p,i)=>`<div class="match-item" id="mr-${i}" data-answer="${escHtml(p[0])}" onclick="selectMatchRight(${i},'${escHtml(p[1])}')">${escHtml(p[1])}</div>`).join('')}</div>
    </div>`;
  } else if (q.type === 'sa') {
    answerHTML = `<div><textarea class="sa-textarea" id="saInput" placeholder="Write your answer here…"></textarea><button class="btn btn-secondary btn-sm" style="margin-top:0.75rem" onclick="checkSA()">Submit & See Answer</button></div>`;
  }

  qc.innerHTML = `
    <div class="quiz-progress-bar"><div class="quiz-progress-fill" style="width:${prog}%"></div></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <span style="font-size:0.85rem;color:var(--text-muted)">Question ${index+1} of ${questions.length}</span>
      ${q.source ? `<button class="source-btn" onmouseenter="showTooltip(event,'Source: ${escHtml(q.source)}')" onmouseleave="hideTooltip()">src</button>` : ''}
    </div>
    <div class="quiz-question-card">
      <div class="question-type-label">${typeLabels[q.type]||q.type}</div>
      ${q.image ? `<img class="sign-img-quiz" src="${q.image}" alt="sign illustration" loading="lazy">` : ''}
      <div class="question-text">${escHtml(q.text)}</div>
      ${answerHTML}
      <div class="feedback-box" id="feedbackBox"></div>
    </div>
    <div style="display:flex;gap:0.75rem;margin-top:1rem">
      <button class="btn btn-secondary" onclick="renderQuizSetup()">✕ End Quiz</button>
      <button class="btn btn-primary" id="nextBtn" onclick="nextQuestion()" style="display:none">Next Question →</button>
    </div>`;
}

function showFeedback(correct, correctAns) {
  const fb = document.getElementById('feedbackBox');
  fb.className = 'feedback-box show ' + (correct ? 'correct' : 'incorrect');
  fb.innerHTML = correct ? '✓ Correct!' : `✗ Incorrect. Correct answer: <strong>${escHtml(correctAns)}</strong>`;
  document.getElementById('nextBtn').style.display = 'inline-flex';
  if (correct) quizState.score++;
}

function showNeutralFeedback(ans) {
  const fb = document.getElementById('feedbackBox');
  fb.className = 'feedback-box show neutral';
  fb.innerHTML = `<strong>Model Answer:</strong> ${escHtml(ans)}`;
  document.getElementById('nextBtn').style.display = 'inline-flex';
}

function selectMC(i) {
  const q = quizState.questions[quizState.index];
  const correct = (q.options && q.options[i] === q.answer) || (i === 0 && !q.options);
  document.querySelectorAll('.mc-option').forEach((el,j) => {
    el.onclick = null;
    if (j === i) el.classList.add(correct ? 'correct' : 'incorrect');
    if (!correct && q.options && q.options[j] === q.answer) el.classList.add('correct');
    if (!correct && !q.options && j === 0) el.classList.add('correct');
  });
  showFeedback(correct, q.answer);
}

function selectTF(val) {
  const q = quizState.questions[quizState.index];
  const correct = val.toLowerCase() === (q.answer||'').toLowerCase();
  document.getElementById('tf-true').classList.add(val==='true'?(correct?'correct':'incorrect'):'');
  document.getElementById('tf-false').classList.add(val==='false'?(correct?'correct':'incorrect'):'');
  if (!correct) document.getElementById('tf-' + q.answer.toLowerCase())?.classList.add('correct');
  document.querySelectorAll('.tf-btn').forEach(b => b.onclick=null);
  showFeedback(correct, q.answer);
}

function checkFITB() {
  const q = quizState.questions[quizState.index];
  const input = document.getElementById('fitbInput');
  const val = input.value.trim().toLowerCase();
  const correct = val && q.answer && val === q.answer.toLowerCase();
  input.classList.add(correct ? 'correct' : 'incorrect');
  input.disabled = true;
  showFeedback(correct, q.answer);
}

function selectMatchLeft(i, term) {
  quizState.matchSelected = { index: i, term };
  document.querySelectorAll('.match-item[id^="ml-"]').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById('ml-' + i);
  if (el && !el.classList.contains('matched')) el.classList.add('selected');
}

function selectMatchRight(i, def) {
  if (!quizState.matchSelected) return;
  const { index: li, term } = quizState.matchSelected;
  const leftEl = document.getElementById('ml-' + li);
  const rightEl = document.getElementById('mr-' + i);
  const q = quizState.questions[quizState.index];
  const pairs = q.pairs || [];
  const correctDef = pairs.find(p => p[0] === term)?.[1];
  const correct = def === correctDef;
  if (correct) {
    leftEl?.classList.replace('selected','matched');
    rightEl?.classList.add('matched');
    quizState.matchSelected = null;
    const matched = document.querySelectorAll('.match-item.matched').length / 2;
    if (matched >= pairs.length) {
      quizState.score++;
      showFeedback(true, '');
      document.getElementById('feedbackBox').innerHTML = '✓ All pairs matched correctly!';
    }
  } else {
    leftEl?.classList.remove('selected');
    rightEl?.classList.add('incorrect');
    setTimeout(() => rightEl?.classList.remove('incorrect'), 600);
    quizState.matchSelected = null;
  }
}

function checkSA() {
  const q = quizState.questions[quizState.index];
  document.getElementById('saInput').disabled = true;
  showNeutralFeedback(q.answer);
}

function nextQuestion() { quizState.index++; renderQuestion(); }

function renderResults() {
  const { score, questions } = quizState;
  const pct = Math.round((score / questions.length) * 100);
  const grade = pct >= 90 ? '🎉 Excellent!' : pct >= 75 ? '👍 Good Work!' : pct >= 60 ? '📚 Keep Studying!' : '💪 Keep Going!';
  document.getElementById('quizContent').innerHTML = `
    <div class="results-card">
      <div class="results-score">${pct}%</div>
      <div class="results-label">${score} of ${questions.length} correct · ${grade}</div>
      <div style="display:flex;gap:1rem;justify-content:center">
        <button class="btn btn-primary" onclick="startQuiz()">Retake Quiz</button>
        <button class="btn btn-secondary" onclick="renderQuizSetup()">New Quiz Setup</button>
      </div>
    </div>`;
}

function updateQuestionForm() {
  const type = document.getElementById('qType').value;
  const el = document.getElementById('qExtraFields');
  if (type === 'mc') {
    el.innerHTML = `<div class="form-group"><label>Answer Options (one per line — first line = correct answer)</label>
    <textarea id="qOptions" placeholder="Correct answer&#10;Wrong option B&#10;Wrong option C&#10;Wrong option D" style="min-height:90px"></textarea></div>`;
  } else if (type === 'match') {
    el.innerHTML = `<div class="form-group"><label>Matching Pairs (format: Term | Definition, one pair per line)</label>
    <textarea id="qPairs" placeholder="Aphasia | Acquired language disorderErikson Stage 1 | Trust vs. Mistrust&#10;Piaget Stage 1 | Sensorimotor#10;Dysarthria | Motor speech disorder" style="min-height:90px"></textarea></div>`;
  } else { el.innerHTML = ''; }
}

function saveQuestion() {
  const type = document.getElementById('qType').value;
  const text = document.getElementById('qText').value.trim();
  const answer = document.getElementById('qAnswer').value.trim();
  if (!text) return alert('Question text is required.');
  const q = {
    id: uid(), type, text, answer,
    module: document.getElementById('qModule').value,
    source: document.getElementById('qSource').value.trim(),
    created: new Date().toISOString()
  };
  if (type === 'mc') {
    const lines = (document.getElementById('qOptions')?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
    q.options = lines.length >= 2 ? lines : [answer, 'Option B', 'Option C', 'Option D'];
    if (!q.answer) q.answer = q.options[0];
  }
  if (type === 'match') {
    const lines = (document.getElementById('qPairs')?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
    q.pairs = lines.map(l => l.split('|').map(s => s.trim())).filter(p => p.length >= 2);
  }
  db.questions.push(q);
  save(); closeModal('modal-question'); updateBadges();
}

// ============================================================
// NOTES
// ============================================================
let currentNoteId = null;

function renderNotes() {
  populateModuleSelects();
  const list = document.getElementById('notesList');
  if (!db.notes.length) {
    list.innerHTML = `<div class="empty-state" style="padding:1.5rem;font-size:0.85rem"><p>No notes yet.</p></div>`;
    return;
  }
  list.innerHTML = db.notes.map(n => `
    <div class="note-list-item${n.id===currentNoteId?' active':''}" onclick="openNote('${n.id}')">
      <div class="note-list-title">${escHtml(n.title||'Untitled')}</div>
      <div class="note-list-meta">${n.module?getModuleName(n.module)+' · ':''}${new Date(n.updated||n.created).toLocaleDateString()}</div>
    </div>`).join('');
  updateBadges();
}

function newNote() {
  currentNoteId = null;
  document.getElementById('noteTitleInput').value = '';
  document.getElementById('noteBodyInput').value = '';
  document.getElementById('noteModuleSelect').value = '';
}

function openNote(id) {
  const note = db.notes.find(n => n.id === id);
  if (!note) return;
  currentNoteId = id;
  populateModuleSelects();
  document.getElementById('noteTitleInput').value = note.title || '';
  document.getElementById('noteBodyInput').value = note.body || '';
  document.getElementById('noteModuleSelect').value = note.module || '';
  renderNotes();
}

function saveNote() {
  const title = document.getElementById('noteTitleInput').value.trim() || 'Untitled';
  const body = document.getElementById('noteBodyInput').value;
  const module = document.getElementById('noteModuleSelect').value;
  if (currentNoteId) {
    const note = db.notes.find(n => n.id === currentNoteId);
    if (note) { note.title = title; note.body = body; note.module = module; note.updated = new Date().toISOString(); }
  } else {
    const n = { id: uid(), title, body, module, created: new Date().toISOString(), updated: new Date().toISOString() };
    db.notes.unshift(n);
    currentNoteId = n.id;
  }
  save(); renderNotes();
}

function deleteCurrentNote() {
  if (!currentNoteId) return;
  if (!confirm('Delete this note?')) return;
  db.notes = db.notes.filter(n => n.id !== currentNoteId);
  currentNoteId = null;
  newNote(); save(); renderNotes();
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  document.getElementById('stat-terms').textContent = db.glossary.length;
  document.getElementById('stat-cards').textContent = db.flashcards.length;
  document.getElementById('stat-questions').textContent = db.questions.length;
  document.getElementById('stat-modules').textContent = db.modules.length;
  const moduleList = document.getElementById('moduleListDash');
  if (!db.modules.length) {
    moduleList.innerHTML = `<div class="empty-state" style="padding:1rem"><p>No modules yet.</p></div>`;
  } else {
    moduleList.innerHTML = db.modules.map(m => {
      const termCount = db.glossary.filter(t => t.module === m.id).length;
      const cardCount = db.flashcards.filter(f => f.module === m.id).length;
      const qCount    = db.questions.filter(q => q.module === m.id).length;
      const noteCount = db.notes.filter(n => n.module === m.id).length;
      return `
      <div class="module-list-item" onclick="showModuleDetail('${m.id}')">
        <span style="font-weight:600;font-size:0.9rem">${escHtml(m.name)}</span>
        <div style="display:flex;gap:0.4rem;flex-wrap:wrap">
          ${termCount  ? `<span class="tag neutral">${termCount} terms</span>` : ''}
          ${cardCount  ? `<span class="tag">${cardCount} cards</span>` : ''}
          ${qCount     ? `<span class="tag warm">${qCount} q's</span>` : ''}
          ${noteCount  ? `<span class="tag neutral">${noteCount} notes</span>` : ''}
        </div>
      </div>`;
    }).join('');
  }
  updateBadges();
}

// ============================================================
// MODULE DETAIL
// ============================================================
function showModuleDetail(moduleId) {
  const mod = db.modules.find(m => m.id === moduleId);
  if (!mod) return;

  // Switch to module page
  showPage('module');

  // Header
  document.getElementById('moduleDetailTitle').textContent = mod.name;
  const terms     = db.glossary.filter(t => t.module === moduleId);
  const cards     = db.flashcards.filter(f => f.module === moduleId);
  const questions = db.questions.filter(q => q.module === moduleId);
  const notes     = db.notes.filter(n => n.module === moduleId);
  const total     = terms.length + cards.length + questions.length + notes.length;
  document.getElementById('moduleDetailSubtitle').textContent =
    `${total} item${total !== 1 ? 's' : ''} — ${terms.length} terms · ${cards.length} cards · ${questions.length} questions · ${notes.length} notes`;

  // Quick action buttons
  document.getElementById('moduleDetailActions').innerHTML = `
    <button class="btn btn-primary btn-sm" onclick="showPage('flashcards'); setFcFilter('${moduleId}')">Study Flashcards →</button>
    <button class="btn btn-secondary btn-sm" onclick="showPage('quiz'); document.getElementById('quizModFilter').value='${moduleId}'">Quiz This Module →</button>
  `;

  const typeLabels = { mc:'MC', tf:'T/F', fitb:'Fill-in', match:'Match', sa:'Short Answer' };

  // Build sections
  let html = '';

  // ── Glossary Terms ────────────────────────────────────────
  html += `<div class="module-detail-section">
    <div class="module-detail-section-header">
      <span class="module-detail-section-title">📖 Glossary Terms</span>
      <span class="module-detail-count">${terms.length}</span>
    </div>`;
  if (!terms.length) {
    html += `<p class="module-detail-empty">No glossary terms in this module.</p>`;
  } else {
    html += terms.map(t => `
      <div class="module-term-row">
        <div class="module-term-name">${escHtml(t.term)}</div>
        <div class="module-term-def">${escHtml(t.def)}</div>
      </div>`).join('');
  }
  html += `</div>`;

  // ── Flashcards ────────────────────────────────────────────
  html += `<div class="module-detail-section">
    <div class="module-detail-section-header">
      <span class="module-detail-section-title">🃏 Flashcards</span>
      <span class="module-detail-count">${cards.length}</span>
    </div>`;
  if (!cards.length) {
    html += `<p class="module-detail-empty">No flashcards in this module.</p>`;
  } else {
    html += cards.map(f => `
      <div class="module-fc-row">
        <div class="module-fc-front">${escHtml(f.front)}</div>
        <div class="module-fc-back">${escHtml(f.back)}</div>
      </div>`).join('');
  }
  html += `</div>`;

  // ── Quiz Questions ────────────────────────────────────────
  html += `<div class="module-detail-section">
    <div class="module-detail-section-header">
      <span class="module-detail-section-title">❓ Quiz Questions</span>
      <span class="module-detail-count">${questions.length}</span>
    </div>`;
  if (!questions.length) {
    html += `<p class="module-detail-empty">No quiz questions in this module.</p>`;
  } else {
    html += questions.map(q => `
      <div class="module-q-row">
        <div class="module-q-type">${typeLabels[q.type] || q.type}</div>
        <div class="module-q-text">${escHtml(q.text)}</div>
      </div>`).join('');
  }
  html += `</div>`;

  // ── Notes ─────────────────────────────────────────────────
  html += `<div class="module-detail-section">
    <div class="module-detail-section-header">
      <span class="module-detail-section-title">📝 Notes</span>
      <span class="module-detail-count">${notes.length}</span>
    </div>`;
  if (!notes.length) {
    html += `<p class="module-detail-empty">No notes in this module.</p>`;
  } else {
    html += notes.map(n => `
      <div class="module-note-row" onclick="showPage('notes'); openNote('${n.id}')">
        <div class="module-note-title">${escHtml(n.title || 'Untitled')}</div>
        <div class="module-note-preview">${escHtml((n.body || '').slice(0, 120))}</div>
      </div>`).join('');
  }
  html += `</div>`;

  document.getElementById('moduleDetailContent').innerHTML = html;
  window.scrollTo(0, 0);
}

// ============================================================
// MANAGE
// ============================================================
let pendingImport = null;

function renderManage() {
  document.getElementById('repoStats').innerHTML =
    `Course: ${db.meta.name}\nModules: ${db.modules.length}\nGlossary Terms: ${db.glossary.length}\nFlashcards: ${db.flashcards.length}\nQuiz Questions: ${db.questions.length}\nNotes: ${db.notes.length}\nCreated: ${new Date(db.meta.created).toLocaleDateString()}`;
  populateModuleSelects();
  renderBulkAssign();
  renderGhSettings();
  renderImageManager();
}

function exportData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = CFG.backupPrefix + new Date().toISOString().slice(0,10) + '.json';
  a.click();
}

function handleClaudeImportDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.json')) readImportFile(file);
}

function previewImport(input) {
  const file = input.files[0];
  if (file) readImportFile(file);
}

function readImportFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      pendingImport = data;
      showImportPreview(data);
    } catch(err) {
      alert('Could not read file: ' + err.message + '\n\nMake sure this is a valid .json file from Claude or a repository backup.');
    }
  };
  reader.readAsText(file);
}

function showImportPreview(data) {
  const preview = document.getElementById('importPreview');
  const content = document.getElementById('importPreviewContent');
  preview.style.display = 'block';

  const isFullBackup = data.meta && data.modules && data.glossary && data.flashcards && data.questions;
  const isContentImport = data.glossary || data.flashcards || data.questions || data.notes;

  if (!isContentImport && !isFullBackup) {
    content.innerHTML = `<div style="color:var(--danger);font-size:0.9rem">⚠ This file doesn't appear to be a valid repository file.</div>`;
    return;
  }

  const sections = [];
  if (isFullBackup && data.modules?.length) sections.push(previewSection('📁 Modules', data.modules, m => m.name, data.modules.length));
  if (data.glossary?.length) sections.push(previewSection('📖 Glossary Terms', data.glossary, t => `<strong>${escHtml(t.term)}</strong> — ${escHtml(t.def?.slice(0,80))}${t.def?.length>80?'…':''}`, data.glossary.length));
  if (data.flashcards?.length) sections.push(previewSection('🃏 Flashcards', data.flashcards, f => escHtml(f.front?.slice(0,80)), data.flashcards.length));
  if (data.questions?.length) {
    const typeLabels = {mc:'MC',tf:'T/F',fitb:'Fill-in',match:'Match',sa:'Short Answer'};
    sections.push(previewSection('❓ Quiz Questions', data.questions, q => `<span class="tag neutral">${typeLabels[q.type]||q.type}</span> ${escHtml(q.text?.slice(0,70))}`, data.questions.length));
  }
  if (data.notes?.length) sections.push(previewSection('📝 Notes', data.notes, n => escHtml(n.title||'Untitled'), data.notes.length));

  if (!sections.length) { content.innerHTML = `<div style="color:var(--text-muted);font-size:0.9rem">This file appears empty — nothing to import.</div>`; return; }

  // Populate module picker for content imports
  const assignPanel = document.getElementById('importModuleAssign');
  if (!isFullBackup && assignPanel) {
    const sel = document.getElementById('importModuleSelect');
    sel.innerHTML = '<option value="">— No Module (import as-is) —</option>' +
      db.modules.map(m => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
    // Pre-select suggested module from meta_import if it matches
    const suggested = data.meta_import?.suggested_module_id;
    if (suggested) {
      const match = db.modules.find(m => m.id === suggested || m.name.toLowerCase() === (data.meta_import?.suggested_module||'').toLowerCase());
      if (match) sel.value = match.id;
    }
    assignPanel.style.display = 'flex';
  } else if (assignPanel) {
    assignPanel.style.display = 'none';
  }

  const mode = isFullBackup
    ? '<span style="background:#fff3e0;color:#8b4a0e;padding:3px 8px;border-radius:10px;font-size:0.75rem;font-weight:700">FULL BACKUP — will REPLACE all data</span>'
    : '<span style="background:var(--tag-bg);color:var(--tag-text);padding:3px 8px;border-radius:10px;font-size:0.75rem;font-weight:700">CONTENT IMPORT — will MERGE with existing data</span>';

  content.innerHTML = `<div style="margin-bottom:1rem">${mode}</div>` + sections.join('');
}

function previewSection(title, items, labelFn, count) {
  const preview = items.slice(0, 3).map(item => `<div style="padding:0.4rem 0;font-size:0.85rem;border-bottom:1px solid var(--surface-2)">${labelFn(item)}</div>`).join('');
  const more = count > 3 ? `<div style="font-size:0.78rem;color:var(--text-light);padding:0.4rem 0">+ ${count - 3} more…</div>` : '';
  return `<div style="margin-bottom:1rem">
    <div style="font-weight:700;font-size:0.88rem;margin-bottom:0.4rem">${title} <span style="font-weight:400;color:var(--text-muted)">(${count} items)</span></div>
    ${preview}${more}
  </div>`;
}

function confirmImport() {
  if (!pendingImport) return;
  const data = pendingImport;
  const isFullBackup = data.meta && data.modules;

  if (isFullBackup) {
    if (!confirm('This will REPLACE all your current data with the backup. Are you sure?')) return;
    db = data;
  } else {
    // Get selected target module (if any)
    const targetMod = document.getElementById('importModuleSelect')?.value || '';
    // Create module from suggested_module if it was in the JSON and doesn't exist yet
    if (targetMod === '' && data.meta_import?.suggested_module) {
      // user chose no module — respect that
    }
    const applyMod = (item) => targetMod ? { ...item, module: targetMod } : item;

    if (data.modules) data.modules.forEach(m => { if (!db.modules.find(x => x.id === m.id)) db.modules.push(m); });
    if (data.glossary) { data.glossary.forEach(t => { if (!db.glossary.find(x => x.id === t.id)) db.glossary.push(applyMod(t)); }); db.glossary.sort((a,b) => a.term.localeCompare(b.term)); }
    if (data.flashcards) data.flashcards.forEach(f => { if (!db.flashcards.find(x => x.id === f.id)) db.flashcards.push(applyMod(f)); });
    if (data.questions) data.questions.forEach(q => { if (!db.questions.find(x => x.id === q.id)) db.questions.push(applyMod(q)); });
    if (data.notes) data.notes.forEach(n => { if (!db.notes.find(x => x.id === n.id)) db.notes.unshift(applyMod(n)); });
  }

  save();
  pendingImport = null;
  document.getElementById('importPreview').style.display = 'none';
  document.getElementById('claudeImportFile').value = '';
  renderDashboard(); renderManage(); updateBadges();
  checkDataAndShowPrompts();
  alert('✓ Import successful! Your repository has been updated.');
}

function cancelImport() {
  pendingImport = null;
  document.getElementById('importPreview').style.display = 'none';
  document.getElementById('claudeImportFile').value = '';
  const assignPanel = document.getElementById('importModuleAssign');
  if (assignPanel) assignPanel.style.display = 'none';
}

function quickCreateModuleForImport() {
  const name = prompt('New module name (e.g. "Module 1", "Week 3", "Chapter 5"):');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (db.modules.find(m => m.name.toLowerCase() === trimmed.toLowerCase())) {
    alert('A module with that name already exists. Select it from the dropdown.'); return;
  }
  const newMod = { id: uid(), name: trimmed, desc: '', created: new Date().toISOString() };
  db.modules.push(newMod);
  save();
  populateModuleSelects();
  const sel = document.getElementById('importModuleSelect');
  if (sel) {
    sel.innerHTML = '<option value="">— No Module (import as-is) —</option>' +
      db.modules.map(m => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
    sel.value = newMod.id;
  }
  renderDashboard();
}

// ── BULK MODULE ASSIGNMENT ──────────────────────────────────────────────────
function renderBulkAssign() {
  const el = document.getElementById('bulkAssignContent');
  if (!el) return;
  if (!db.modules.length) {
    el.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">Create at least one module first, then come back here to assign existing items.</p>';
    return;
  }
  const modOpts = db.modules.map(m => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
  const rows = [
    { label: 'Glossary Terms', key: 'glossary', icon: '📖' },
    { label: 'Flashcards',     key: 'flashcards', icon: '🃏' },
    { label: 'Quiz Questions', key: 'questions',  icon: '❓' },
    { label: 'Notes',          key: 'notes',      icon: '📝' },
  ];
  el.innerHTML = rows.map(r => {
    const unassigned = (db[r.key]||[]).filter(x => !x.module).length;
    const total = (db[r.key]||[]).length;
    return `<div class="bulk-assign-row">
      <label>${r.icon} ${r.label}</label>
      <select id="bulk_sel_${r.key}">${modOpts}</select>
      <button class="btn btn-primary btn-xs" onclick="bulkAssign('${r.key}','unassigned')">
        Assign unassigned <span class="bulk-stats">(${unassigned} of ${total})</span>
      </button>
      <button class="btn btn-xs" onclick="bulkAssign('${r.key}','all')" style="background:var(--surface-2)">
        Reassign all <span class="bulk-stats">(${total})</span>
      </button>
    </div>`;
  }).join('') +
  `<p style="font-size:0.78rem;color:var(--text-muted);margin-top:0.75rem">
    <strong>Assign unassigned</strong> — only items not yet in any module.&nbsp;
    <strong>Reassign all</strong> — overwrite the module for every item in that section.
  </p>`;
}

function bulkAssign(section, mode) {
  const sel = document.getElementById('bulk_sel_' + section);
  if (!sel || !sel.value) { alert('Please select a module first.'); return; }
  const modId = sel.value;
  const modName = db.modules.find(m => m.id === modId)?.name || '';
  const items = db[section] || [];
  if (!items.length) { alert('No items in this section.'); return; }
  let count = 0;
  items.forEach(item => { if (mode === 'all' || !item.module) { item.module = modId; count++; } });
  if (section === 'glossary') db.glossary.sort((a,b) => a.term.localeCompare(b.term));
  save(); renderBulkAssign(); renderDashboard(); updateBadges();
  alert(`✓ Assigned ${count} ${section} to "${modName}".`);
}

function clearAllData() {
  if (!confirm('Delete ALL data permanently? This cannot be undone.')) return;
  db = { meta: { ...db.meta, created: db.meta.created }, modules: [], glossary: [], flashcards: [], questions: [], notes: [] };
  save(); renderDashboard(); renderManage(); updateBadges();
  alert('All data cleared.');
}

// ============================================================
// GLOBAL SEARCH
// ============================================================
function globalSearchHandler(q) {
  showPage('search');
  const input = document.getElementById('searchPageInput');
  if (input) input.value = q;
  runSearch(q);
}

// ============================================================
// SEARCH ENGINE
// ============================================================
function runSearch(raw) {
  const q = (raw || '').trim().toLowerCase();
  const meta = document.getElementById('searchMeta');
  const results = document.getElementById('searchResults');

  if (!q) {
    meta.textContent = '';
    results.innerHTML = `<div class="search-prompt"><div class="icon">🔍</div><p>Start typing to search across all your study material.</p></div>`;
    return;
  }

  const hl = (str) => {
    if (!str) return '';
    const safe = escHtml(String(str));
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  };

  const sections = [];
  let totalHits = 0;

  // GLOSSARY
  const glossHits = db.glossary.filter(t =>
    t.term.toLowerCase().includes(q) || t.def.toLowerCase().includes(q)
  );
  if (glossHits.length) {
    totalHits += glossHits.length;
    const items = glossHits.map(t => `
      <div class="search-result" onclick="showPage('glossary'); document.getElementById('glossarySearch').value=${JSON.stringify(raw)}; renderGlossary();">
        <div class="search-result-type">📖 Glossary</div>
        <div class="search-result-title">${hl(t.term)}</div>
        <div class="search-result-preview">${hl(t.def)}</div>
      </div>`).join('');
    sections.push(`<div class="search-section">
      <div class="search-section-header">
        <span class="search-section-title">Glossary</span>
        <span class="search-count">${glossHits.length}</span>
      </div>${items}</div>`);
  }

  // FLASHCARDS
  const fcHits = db.flashcards.filter(f =>
    f.front.toLowerCase().includes(q) || f.back.toLowerCase().includes(q)
  );
  if (fcHits.length) {
    totalHits += fcHits.length;
    const items = fcHits.map(f => `
      <div class="search-result" onclick="showPage('flashcards');">
        <div class="search-result-type">🃏 Flashcard</div>
        <div class="search-result-title">${hl(f.front)}</div>
        <div class="search-result-preview">${hl(f.back)}</div>
      </div>`).join('');
    sections.push(`<div class="search-section">
      <div class="search-section-header">
        <span class="search-section-title">Flashcards</span>
        <span class="search-count">${fcHits.length}</span>
      </div>${items}</div>`);
  }

  // QUESTIONS
  const qHits = db.questions.filter(q2 =>
    q2.text.toLowerCase().includes(q) || (q2.answer||'').toLowerCase().includes(q) ||
    (q2.options||[]).some(o => o.toLowerCase().includes(q))
  );
  if (qHits.length) {
    totalHits += qHits.length;
    const typeLabels = { mc:'Multiple Choice', tf:'True/False', fitb:'Fill-in', match:'Matching', sa:'Short Answer' };
    const items = qHits.map(q2 => `
      <div class="search-result" onclick="showPage('quiz');">
        <div class="search-result-type">❓ Quiz — ${typeLabels[q2.type]||q2.type}</div>
        <div class="search-result-title">${hl(q2.text)}</div>
        <div class="search-result-preview">Answer: ${hl(q2.answer)}</div>
      </div>`).join('');
    sections.push(`<div class="search-section">
      <div class="search-section-header">
        <span class="search-section-title">Quiz Questions</span>
        <span class="search-count">${qHits.length}</span>
      </div>${items}</div>`);
  }

  // NOTES
  const noteHits = db.notes.filter(n =>
    (n.title||'').toLowerCase().includes(q) || (n.body||'').toLowerCase().includes(q)
  );
  if (noteHits.length) {
    totalHits += noteHits.length;
    const items = noteHits.map(n => `
      <div class="search-result" onclick="showPage('notes'); openNote('${n.id}');">
        <div class="search-result-type">📝 Note</div>
        <div class="search-result-title">${hl(n.title||'Untitled')}</div>
        <div class="search-result-preview">${hl((n.body||'').slice(0,200))}</div>
      </div>`).join('');
    sections.push(`<div class="search-section">
      <div class="search-section-header">
        <span class="search-section-title">Notes</span>
        <span class="search-count">${noteHits.length}</span>
      </div>${items}</div>`);
  }

  meta.textContent = totalHits
    ? `${totalHits} result${totalHits !== 1 ? 's' : ''} for "${raw}"`
    : '';

  results.innerHTML = sections.length
    ? sections.join('')
    : `<div class="search-prompt"><div class="icon">🔍</div><p>No results found for "<strong>${escHtml(raw)}</strong>".<br>Try a different term or check your spelling.</p></div>`;
}

// ============================================================
// HELPERS
// ============================================================
function updateBadges() {
  document.getElementById('fcBadge').textContent = db.flashcards.length;
  document.getElementById('quizBadge').textContent = db.questions.length;
  document.getElementById('glossBadge').textContent = db.glossary.length;
  document.getElementById('notesBadge').textContent = db.notes.length;
  document.getElementById('stat-terms').textContent = db.glossary.length;
  document.getElementById('stat-cards').textContent = db.flashcards.length;
  document.getElementById('stat-questions').textContent = db.questions.length;
  document.getElementById('stat-modules').textContent = db.modules.length;
}

function getModuleName(id) { return db.modules.find(m => m.id === id)?.name || ''; }

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function showTooltip(e, text) {
  const t = document.getElementById('sourceTooltip');
  t.textContent = text;
  t.classList.add('visible');
  t.style.left = (e.clientX + 12) + 'px';
  t.style.top = (e.clientY - 8) + 'px';
}

function hideTooltip() { document.getElementById('sourceTooltip').classList.remove('visible'); }

// Modal overlay click-to-close (deferred in case DOM not ready)
function setupModalOverlays() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  });
}


// ============================================================
// IMAGE MANAGER
// ============================================================
// Uploads images to the repo's images/ folder via GitHub API
// and provides a visual gallery for copying image URLs.
// Images are referenced in JSON imports via the "image" field.

let imgManagerState = {
  uploading: false,
  gallery: [],   // {name, url} — built from known images in db
};

function renderImageManager() {
  const el = document.getElementById('imageManagerContent');
  if (!el) return;

  const configured = ghConfigured();
  const { username, repo } = ghSettings || {};
  const baseUrl = configured
    ? `https://${username}.github.io/${repo}/images/`
    : `https://thetripleb.github.io/${CFG.repoName}/images/`;

  // Collect all image URLs referenced in the db
  const allImgUrls = new Set();
  db.glossary.forEach(t => { if (t.image) allImgUrls.add(t.image); });
  db.flashcards.forEach(f => { if (f.image) allImgUrls.add(f.image); });
  db.questions.forEach(q => { if (q.image) allImgUrls.add(q.image); });

  el.innerHTML = `
    <div style="margin-bottom:1.25rem">
      <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem;line-height:1.6">
        Images are stored in the <code>images/</code> folder of your GitHub repo and referenced by URL
        in glossary terms, flashcards, and quiz questions.
        ${configured
          ? `<br>Your images folder: <a href="${baseUrl}" target="_blank" style="color:var(--accent)">${baseUrl}</a>`
          : `<br><strong>Configure GitHub sync first</strong> to enable image uploads.`}
      </div>
      ${configured ? `
        <label class="img-upload-zone" id="imgUploadZone"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="handleImageDrop(event)">
          <input type="file" id="imgFileInput" accept="image/*" multiple
            onchange="handleImageSelect(this.files)">
          <div class="upload-icon">🖼</div>
          <p>Drop images here or click to browse</p>
          <p style="font-size:0.78rem;margin-top:0.3rem">JPG, PNG, GIF, WebP — uploads directly to GitHub</p>
        </label>
        <div class="img-upload-progress" id="imgUploadProgress"></div>
      ` : ''}
    </div>

    ${allImgUrls.size > 0 ? `
      <div style="font-weight:700;font-size:0.88rem;margin-bottom:0.75rem">
        Images in use (${allImgUrls.size})
        <span style="font-weight:400;font-size:0.78rem;color:var(--text-muted);margin-left:0.5rem">
          Click URL button to copy
        </span>
      </div>
      <div class="img-grid">
        ${[...allImgUrls].sort().map(url => {
          const name = url.split('/').pop();
          return `
            <div class="img-grid-item" title="${url}">
              <img src="${url}" alt="${name}" loading="lazy"
                onerror="this.style.opacity=0.3;this.title='Image not found'">
              <button class="img-copy-btn" onclick="copyImageUrl('${url}',event)">copy URL</button>
              <div class="img-name">${name}</div>
            </div>`;
        }).join('')}
      </div>
    ` : `<p style="font-size:0.85rem;color:var(--text-muted)">
        No images referenced in your data yet.
        Upload images above, then reference them in glossary terms, flashcards,
        or quiz questions using the <code>image</code> field in Claude import JSON.
      </p>`}
  `;
}

async function handleImageDrop(e) {
  e.preventDefault();
  document.getElementById('imgUploadZone')?.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  if (files.length) await uploadImagesToGitHub(files);
}

async function handleImageSelect(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (files.length) await uploadImagesToGitHub(files);
}

async function uploadImagesToGitHub(files) {
  if (!ghConfigured()) {
    alert('Please configure GitHub sync first (Settings → GitHub Sync).');
    return;
  }
  if (imgManagerState.uploading) return;
  imgManagerState.uploading = true;

  const { username, repo, pat, branch } = ghSettings;
  const b = branch || 'main';
  const base = `https://api.github.com/repos/${username}/${repo}`;
  const headers = {
    Authorization: `token ${pat}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  const prog = document.getElementById('imgUploadProgress');
  let uploaded = 0;
  let failed = 0;

  for (const file of files) {
    if (prog) prog.textContent = `Uploading ${file.name}… (${uploaded+1}/${files.length})`;

    try {
      // Read file as base64
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      // Check if file exists (get SHA for update)
      const checkRes = await fetch(`${base}/contents/images/${file.name}`, { headers });
      const sha = checkRes.ok ? (await checkRes.json()).sha : null;

      const payload = {
        message: `feat: add image ${file.name}`,
        content: b64,
        branch: b,
      };
      if (sha) payload.sha = sha;

      const putRes = await fetch(`${base}/contents/images/${file.name}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      });

      if (putRes.ok) {
        uploaded++;
      } else {
        const err = await putRes.json().catch(() => ({}));
        console.warn(`Upload failed for ${file.name}:`, err.message);
        failed++;
      }
    } catch (e) {
      console.error(`Upload error for ${file.name}:`, e);
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  imgManagerState.uploading = false;
  if (prog) {
    prog.textContent = failed === 0
      ? `✓ Uploaded ${uploaded} image${uploaded !== 1 ? 's' : ''}. GitHub Pages deploys in ~1 minute.`
      : `Uploaded ${uploaded}, failed ${failed}. Check console for details.`;
  }

  // Refresh the gallery
  renderImageManager();
}

function copyImageUrl(url, e) {
  e.stopPropagation();
  navigator.clipboard.writeText(url).then(() => {
    const btn = e.target;
    const orig = btn.textContent;
    btn.textContent = 'copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

// ============================================================
// INIT
// ============================================================

// ── BACKUP & RESTORE ─────────────────────────────────────────────────────────
function checkDataAndShowPrompts() {
  const hasData = db.glossary.length > 0 || db.flashcards.length > 0 ||
                  db.questions.length > 0 || db.notes.length > 0;
  // Show/hide backup banner on dashboard
  const banner = document.getElementById('backupBanner');
  if (banner) banner.style.display = hasData ? 'flex' : 'none';
  // Show restore overlay if no data and user hasn't dismissed it this session
  const overlay = document.getElementById('restoreOverlay');
  if (overlay) {
    const dismissed = sessionStorage.getItem(CFG.dismissKey);
    overlay.style.display = (!hasData && !dismissed) ? 'flex' : 'none';
  }
}

function dismissRestore() {
  sessionStorage.setItem(CFG.dismissKey, '1');
  const overlay = document.getElementById('restoreOverlay');
  if (overlay) overlay.style.display = 'none';
}

function handleRestoreFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      // Must be a full backup (has meta + at least one data array)
      if (!data.meta && !data.modules) {
        alert('This does not appear to be a full repository backup.\n\nUse Manage Data → Import for content-only imports.');
        return;
      }
      db = data;
      save();
      dismissRestore();
      renderDashboard();
      updateBadges();
      checkDataAndShowPrompts();
      alert('✓ Data restored successfully! Your repository is back.');
    } catch(err) {
      alert('Could not read backup file: ' + err.message);
    }
  };
  reader.readAsText(file);
}

async function initApp() {
  // Render shell immediately so page feels instant
  try {
    renderDashboard();
    updateQuestionForm();
  } catch(e) {
    console.error(`${CFG.appName}: Initial render error:`, e);
  }
  // Load data (async — fetches from GitHub if configured, else localStorage)
  try {
    await load();
    renderDashboard();
    updateBadges();
    checkDataAndShowPrompts();
  } catch(e) {
    console.warn(`${CFG.appName}: Load error:`, e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
