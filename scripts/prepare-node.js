/**
 * Copy the current Node binary into build-resources for packaging.
 * The packaged app runs the Express server with this binary so native
 * modules (sharp) match the ABI used during npm install.
 */
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'build-resources');
const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';
const outPath = path.join(outDir, binaryName);

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(process.execPath, outPath);

// Ensure executable bit on Unix
if (process.platform !== 'win32') {
  fs.chmodSync(outPath, 0o755);
}

console.log(`Copied Node binary to ${outPath}`);
