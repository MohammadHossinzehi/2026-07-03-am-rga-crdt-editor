'use strict';

// Interactive demo: three RGA replicas ("alice", "bob", "carol") wired
// together by a fake network that applies a random delay to every message
// and can deliver them out of order. Every button click is a local edit on
// one replica that gets broadcast (with jitter) to the other two. The
// "converged?" badge simply compares the three visible strings - it turns
// green whenever they match, which after any burst of edits they always
// eventually do, no matter how badly the network scrambled delivery order.

const SITES = ['alice', 'bob', 'carol'];
const docs = {};
SITES.forEach((s) => (docs[s] = new RGA(s)));

const clientsEl = document.getElementById('clients');
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const delayInput = document.getElementById('delay');
const delayLabel = document.getElementById('delayLabel');

delayInput.addEventListener('input', () => {
  delayLabel.textContent = delayInput.value + 'ms';
});

function log(msg) {
  const line = document.createElement('div');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function render() {
  SITES.forEach((s) => {
    const el = document.getElementById('doc-' + s);
    if (el) el.textContent = docs[s].toString() || '(empty)';
  });
  const strings = SITES.map((s) => docs[s].toString());
  const converged = strings.every((v) => v === strings[0]);
  const pending = SITES.reduce((sum, s) => sum + docs[s].pendingCount, 0);
  statusEl.innerHTML = converged
    ? '<span class="ok">converged</span> - all three replicas show the same text' + (pending ? (' (' + pending + ' ops still in flight)') : '')
    : '<span class="pending">not converged yet</span> - ' + pending + ' op(s) still buffered or in flight across the network';
}

// Simulated unreliable network: every op gets its own random delay, so
// messages routinely arrive out of order relative to one another.
function broadcast(fromSite, op) {
  if (!op) return;
  SITES.forEach((s) => {
    if (s === fromSite) return;
    const base = Number(delayInput.value);
    const delay = Math.random() * base;
    setTimeout(() => {
      docs[s].applyRemote(op);
      render();
    }, delay);
  });
}

function localInsert(site, char) {
  const pos = docs[site].length;
  const op = docs[site].insertAt(pos, char);
  log(site + ' inserted "' + char + '" (id ' + op.id + ')');
  render();
  broadcast(site, op);
}

function localDeleteLast(site) {
  const pos = docs[site].length - 1;
  if (pos < 0) return;
  const op = docs[site].deleteAt(pos);
  if (!op) return;
  log(site + ' deleted last character (id ' + op.id + ')');
  render();
  broadcast(site, op);
}

function randomWord() {
  const words = ['hello', 'world', 'crdt', 'sync', 'merge', 'text', 'rga', 'demo'];
  return words[Math.floor(Math.random() * words.length)];
}

function chaosBurst() {
  log('--- chaos burst: all 3 clients edit concurrently, network jittered ---');
  SITES.forEach((site) => {
    const word = randomWord();
    const pos = Math.floor(Math.random() * (docs[site].length + 1));
    let p = pos;
    for (const ch of word) {
      const op = docs[site].insertAt(p, ch);
      broadcast(site, op);
      p++;
    }
    log(site + ' typed "' + word + '" at position ' + pos);
  });
  render();
}

function reset() {
  SITES.forEach((s) => (docs[s] = new RGA(s)));
  logEl.innerHTML = '';
  log('reset all replicas');
  render();
}

function buildUI() {
  clientsEl.innerHTML = '';
  SITES.forEach((site) => {
    const card = document.createElement('div');
    card.className = 'client';
    card.innerHTML =
      '<h2>' + site[0].toUpperCase() + site.slice(1) + '</h2>' +
      '<div class="doc" id="doc-' + site + '"></div>' +
      '<div class="btns">' +
      '<button data-site="' + site + '" class="type-btn">Type random letter</button>' +
      '<button data-site="' + site + '" class="word-btn">Type random word</button>' +
      '<button data-site="' + site + '" class="del-btn">Delete last char</button>' +
      '</div>';
    clientsEl.appendChild(card);
  });

  clientsEl.querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ch = String.fromCharCode(97 + Math.floor(Math.random() * 26));
      localInsert(btn.dataset.site, ch);
    });
  });
  clientsEl.querySelectorAll('.word-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const word = randomWord() + ' ';
      const site = btn.dataset.site;
      let pos = docs[site].length;
      for (const ch of word) {
        localInsert(site, ch);
        pos++;
      }
    });
  });
  clientsEl.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', () => localDeleteLast(btn.dataset.site));
  });
}

document.getElementById('chaosBtn').addEventListener('click', chaosBurst);
document.getElementById('resetBtn').addEventListener('click', reset);

buildUI();
render();
log('ready - 3 replicas initialized, all empty');
