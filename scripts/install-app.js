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
