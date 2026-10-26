// Dependency-free "build": copies src/ to dist/ and stamps the build time. Proves the install -> build -> publish pipeline
// works without needing a package registry. Set FAIL_BUILD=1 (as an env var) to simulate a failing build.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
if (process.env.FAIL_BUILD === '1') { console.error('Simulated build failure'); process.exit(2); }
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('src', 'dist', { recursive: true });
const html = readFileSync('dist/index.html', 'utf8').replace('__BUILT_AT__', new Date().toISOString());
writeFileSync('dist/index.html', html);
console.log('Built', html.length, 'bytes');
