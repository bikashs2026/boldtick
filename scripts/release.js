// scripts/release.js — cut a BoldTick release (MAJOR.MINOR)
//
//   npm run release -- minor            0.4 → 0.5
//   npm run release -- major            0.5 → 1.0
//   npm run release -- minor --dry-run  show what would happen, change nothing
//
// Refuses with uncommitted changes, an empty Unreleased section or failing tests.
// See docs/RELEASING.md.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const kind = args.find(a => a === 'major' || a === 'minor');
const dry = args.includes('--dry-run');
const skipTests = args.includes('--skip-tests'); // for the release script's own test only

const fail = msg => { console.error(`✖ ${msg}`); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

if (!kind) fail('say which number to bump: npm run release -- minor   (or major)');

// 1. Clean working tree
let status;
try { status = git('status', '--porcelain'); } catch { fail('not a git repository'); }
if (status) fail(`commit or stash your changes first:\n${status}`);

// 2. Next version
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [major, minor] = pkg.version.split('.').map(Number);
const next = kind === 'major' ? { major: major + 1, minor: 0 } : { major, minor: minor + 1 };
const label = `${next.major}.${next.minor}`;
const tag = `v${label}`;
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`);

// 3. Changelog: Unreleased must have content
const clPath = path.join(ROOT, 'CHANGELOG.md');
const cl = fs.readFileSync(clPath, 'utf8');
const head = '## [Unreleased]';
const at = cl.indexOf(head);
if (at < 0) fail('CHANGELOG.md has no "## [Unreleased]" section');
const after = cl.slice(at + head.length);
const nextSection = after.search(/\n## \[/);
const body = (nextSection < 0 ? after : after.slice(0, nextSection)).trim();
if (!body) fail('the Unreleased section in CHANGELOG.md is empty — describe the changes first');

// 4. Tests
if (!skipTests) {
  console.log('Running tests…');
  const t = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--silent'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (t.status !== 0) fail('tests failed — not releasing');
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const newCl = cl.slice(0, at) + `${head}\n\n## [${label}] — ${today}\n\n${body}\n` + (nextSection < 0 ? '' : after.slice(nextSection));

console.log(`\nRelease ${pkg.version.split('.').slice(0, 2).join('.')} → ${label} (${today})\n`);
console.log(body.split('\n').map(l => '  ' + l).join('\n'));
if (dry) { console.log('\n(dry run — nothing changed)'); process.exit(0); }

// 5. Write, commit, tag
fs.writeFileSync(clPath, newCl);
pkg.version = `${label}.0`;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const lockPath = path.join(ROOT, 'package-lock.json');
const files = ['CHANGELOG.md', 'package.json'];
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = pkg.version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = pkg.version;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  files.push('package-lock.json');
}
git('add', ...files);
git('commit', '-m', `Release ${tag}`);
git('tag', '-a', tag, '-m', `BoldTick ${label}\n\n${body}`);
console.log(`\n✔ Released ${tag}. Push when ready: git push --follow-tags`);
