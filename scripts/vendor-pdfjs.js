'use strict';
/** Copy pdf.js into renderer/vendor so the renderer can import it directly,
 *  with no bundler and no module resolution into node_modules at runtime. */
const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build');
const to = path.join(__dirname, '..', 'renderer', 'vendor');
fs.mkdirSync(to, { recursive: true });
for (const f of ['pdf.mjs', 'pdf.worker.mjs']) {
  fs.copyFileSync(path.join(from, f), path.join(to, f));
}
console.log('vendored pdf.js ->', path.relative(process.cwd(), to));
