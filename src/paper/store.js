// src/paper/store.js — JSON-file storage
//
// Whole-file documents are written to "<name>.tmp" and renamed over the
// original, so a crash mid-write never leaves half a file. Logs are JSON Lines,
// one object appended per line. Writes are synchronous: Node runs one handler
// at a time, so there is never a second writer to race with.

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) { return path.join(this.dir, name); }

  // Missing file → default. Unreadable file → throw (never start empty over real data).
  load(name, fallback) {
    const f = this.file(name);
    if (!fs.existsSync(f)) return fallback;
    const text = fs.readFileSync(f, 'utf8');
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Paper Desk data file is unreadable: ${f} (${e.message}). Fix or restore it from data/paper/backup before starting.`);
    }
  }

  save(name, data) {
    const f = this.file(name);
    const tmp = f + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, f);
  }

  append(name, obj) {
    fs.appendFileSync(this.file(name), JSON.stringify(obj) + '\n');
  }

  readLines(name, { limit = Infinity } = {}) {
    const f = this.file(name);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const slice = Number.isFinite(limit) ? lines.slice(-limit) : lines;
    const out = [];
    for (const l of slice) { try { out.push(JSON.parse(l)); } catch { /* skip a torn last line */ } }
    return out;
  }

  // Copy every file into backup/<date>/ and keep the newest `keep` days.
  backup(dateStr, keep = 30) {
    const root = path.join(this.dir, 'backup');
    const dest = path.join(root, dateStr);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(this.dir)) {
      const src = path.join(this.dir, name);
      if (name === 'backup' || name.endsWith('.tmp') || !fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(dest, name));
    }
    const days = fs.readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const old of days.slice(0, Math.max(0, days.length - keep))) {
      fs.rmSync(path.join(root, old), { recursive: true, force: true });
    }
    return dest;
  }
}

// Windows can briefly lock a file (antivirus, indexer) → EPERM/EBUSY on rename.
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 9) throw e;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* brief spin; writes are tiny and rare */ }
    }
  }
}

module.exports = { Store };
