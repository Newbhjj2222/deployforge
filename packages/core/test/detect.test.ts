import { describe, expect, it } from 'vitest';
import { detectFramework, memoryProbe } from '../src/detect';

const pkg = (o: object) => JSON.stringify(o);

describe('framework detection', () => {
  it('detects plain static sites', async () => {
    const d = await detectFramework(memoryProbe({ 'index.html': '<h1>hi</h1>' }));
    expect(d).toMatchObject({ framework: 'STATIC', supported: true, buildCommand: null, outputDirectory: '.' });
  });

  it('detects Vite and picks the package manager from lockfiles', async () => {
    const d = await detectFramework(
      memoryProbe({ 'package.json': pkg({ devDependencies: { vite: '^5' } }), 'pnpm-lock.yaml': '' }),
    );
    expect(d).toMatchObject({ framework: 'VITE', installCommand: 'pnpm install --frozen-lockfile', buildCommand: 'pnpm run build', outputDirectory: 'dist' });
    const d2 = await detectFramework(memoryProbe({ 'package.json': pkg({ devDependencies: { vite: '^5' } }), 'package-lock.json': '{}' }));
    expect(d2.installCommand).toBe('npm ci');
  });

  it('detects Create React App and generic React', async () => {
    expect((await detectFramework(memoryProbe({ 'package.json': pkg({ dependencies: { 'react-scripts': '5' } }) }))).outputDirectory).toBe('build');
    expect((await detectFramework(memoryProbe({ 'package.json': pkg({ dependencies: { react: '19' } }) }))).framework).toBe('REACT');
  });

  it('marks Next.js as supported only with static export', async () => {
    const server = await detectFramework(memoryProbe({ 'package.json': pkg({ dependencies: { next: '15' } }), 'next.config.mjs': 'export default {}' }));
    expect(server).toMatchObject({ framework: 'NEXTJS', supported: false });
    const exp = await detectFramework(memoryProbe({ 'package.json': pkg({ dependencies: { next: '15' } }), 'next.config.mjs': "export default { output: 'export' }" }));
    expect(exp).toMatchObject({ framework: 'NEXTJS', supported: true, outputDirectory: 'out' });
  });

  it('detects FastAPI with its entrypoint', async () => {
    const d = await detectFramework(
      memoryProbe({
        'requirements.txt': 'fastapi==0.115\nuvicorn',
        'main.py': 'from fastapi import FastAPI\nserver = FastAPI()\n',
        '.python-version': '3.11\n',
      }),
    );
    expect(d).toMatchObject({ framework: 'FASTAPI', runtime: 'PYTHON', pythonVersion: '3.11', supported: true });
    expect(d.startCommand).toBe('uvicorn main:server --host 0.0.0.0 --port $PORT');
  });

  it('detects Flask', async () => {
    const d = await detectFramework(memoryProbe({ 'requirements.txt': 'Flask\ngunicorn', 'app.py': 'app = Flask(__name__)' }));
    expect(d).toMatchObject({ framework: 'FLASK', runtime: 'PYTHON' });
    expect(d.startCommand).toBe('gunicorn app:app --bind 0.0.0.0:$PORT');
  });

  it('never trusts a repository to supply commands and reports unknown projects honestly', async () => {
    const d = await detectFramework(memoryProbe({ 'README.md': '# nothing' }));
    expect(d).toMatchObject({ framework: 'OTHER', supported: false });
  });

  it('tolerates broken package.json', async () => {
    const d = await detectFramework(memoryProbe({ 'package.json': '{oops', 'index.html': 'x' }));
    expect(d.framework).toBe('STATIC');
  });
});
