// src/version.js — the BoldTick release number, read from package.json.
// Releases are MAJOR.MINOR (see docs/RELEASING.md); package.json keeps a
// trailing .0 only because npm requires three numbers.

const { version: SEMVER } = require('../package.json');
const [MAJOR, MINOR] = SEMVER.split('.').map(Number);

module.exports = { VERSION: `${MAJOR}.${MINOR}`, MAJOR, MINOR, SEMVER };
