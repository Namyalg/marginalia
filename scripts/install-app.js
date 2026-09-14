'use strict';
/**
 * Put the packaged app on the Desktop and pin it to the Dock.
 * Run after `npm run pack`.
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'Marginalia';
const built = path.join(__dirname, '..', 'dist', `${NAME}-darwin-${process.arch}`, `${NAME}.app`);
const dest = path.join(os.homedir(), 'Desktop', `${NAME}.app`);

if (!fs.existsSync(built)) {
  console.error(`No build found at ${built}. Run: npm run pack`);
  process.exit(1);
}

// The packager ships Electron's own icon under this name; ours replaces it.
const icns = path.join(__dirname, '..', 'build', 'icon.icns');
if (fs.existsSync(icns)) {
  fs.copyFileSync(icns, path.join(built, 'Contents', 'Resources', 'electron.icns'));
}

// MIT, Apache-2.0 and the OFL all require their notices to travel with the
// code. @electron/packager writes Electron's and Chromium's beside the bundle,
// so handing someone just Marginalia.app would ship their code without them.
// Put everything inside Contents/Resources/, where the Licenses menu item and
// anyone poking at the bundle can find it.
const outDir = path.join(__dirname, '..', 'dist', `${NAME}-darwin-${process.arch}`);
const resources = path.join(built, 'Contents', 'Resources');
const notices = [
  [path.join(__dirname, '..', 'THIRD-PARTY-LICENSES.md'), 'THIRD-PARTY-LICENSES.md'],
  [path.join(__dirname, '..', 'LICENSE'), 'LICENSE'],
  [path.join(outDir, 'LICENSES.chromium.html'), 'LICENSES.chromium.html'],
  [path.join(outDir, 'LICENSE'), 'LICENSE.electron'],
];
for (const [from, to] of notices) {
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(resources, to));
  else console.warn(`missing notice: ${path.basename(from)} — run npm run pack first`);
}

// Ad-hoc signature: unsigned bundles get refused more often than not.
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', built], { stdio: 'ignore' });
} catch { console.warn('ad-hoc signing failed; the app may need Gatekeeper approval'); }

fs.rmSync(dest, { recursive: true, force: true });
execFileSync('cp', ['-R', built, dest]);
try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', dest], { stdio: 'ignore' }); } catch {}
fs.utimesSync(dest, new Date(), new Date());          // nudge the icon cache
console.log(`installed → ${dest}`);

// Pin it, unless it is already there.
let pinned = '';
try { pinned = execSync('defaults read com.apple.dock persistent-apps', { encoding: 'utf8' }); } catch {}
if (pinned.includes(`${NAME}.app`)) {
  console.log('already pinned to the Dock');
} else {
  execFileSync('defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add',
    `<dict><key>tile-data</key><dict><key>file-data</key><dict>` +
    `<key>_CFURLString</key><string>${dest}</string>` +
    `<key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>`]);
  execFileSync('killall', ['Dock']);
  console.log('pinned to the Dock');
}
