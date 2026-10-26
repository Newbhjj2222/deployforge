/**
 * Framework detection from repository FILES. Output is a *suggestion* shown to the project owner;
 * commands are platform-defined presets, never read from repo scripts and executed implicitly,
 * and always run inside the sandbox (never in the control plane).
 */
export type Framework = 'STATIC' | 'VITE' | 'REACT' | 'NEXTJS' | 'FASTAPI' | 'FLASK' | 'OTHER';
export type RuntimeKind = 'STATIC' | 'PYTHON';

export interface FileProbe {
  /** Return file contents (utf8) or null when the file does not exist. Paths are repo-relative. */
  read(path: string): Promise<string | null>;
}

export interface Detection {
  framework: Framework;
  label: string;
  runtime: RuntimeKind;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
  pythonVersion: string | null;
  port: number;
  healthCheckPath: string;
  supported: boolean;
  notes: string[];
}

export const DEFAULT_PYTHON_VERSION = '3.12';
export const DEFAULT_PORT = 8000;

const base = (): Detection => ({
  framework: 'OTHER',
  label: 'Unknown',
  runtime: 'STATIC',
  installCommand: null,
  buildCommand: null,
  outputDirectory: null,
  startCommand: null,
  pythonVersion: null,
  port: DEFAULT_PORT,
  healthCheckPath: '/health',
  supported: false,
  notes: [],
});

function safeJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const present = async (probe: FileProbe, p: string) => (await probe.read(p)) !== null;

export async function detectNodeInstall(probe: FileProbe): Promise<string> {
  if (await present(probe, 'pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (await present(probe, 'yarn.lock')) return 'yarn install --frozen-lockfile';
  if (await present(probe, 'package-lock.json')) return 'npm ci';
  return 'npm install';
}

function runScript(installCmd: string): string {
  if (installCmd.startsWith('pnpm')) return 'pnpm run build';
  if (installCmd.startsWith('yarn')) return 'yarn build';
  return 'npm run build';
}

const hasDep = (pkg: Record<string, unknown>, name: string) => {
  const d = (pkg.dependencies ?? {}) as Record<string, string>;
  const dd = (pkg.devDependencies ?? {}) as Record<string, string>;
  return name in d || name in dd;
};

async function pythonDeps(probe: FileProbe): Promise<string> {
  const parts = await Promise.all([probe.read('requirements.txt'), probe.read('pyproject.toml'), probe.read('Pipfile')]);
  return parts.filter(Boolean).join('\n').toLowerCase();
}

/** Find a module:attribute entrypoint by looking for `app = FastAPI(` / `app = Flask(`. */
async function findEntry(probe: FileProbe, ctor: 'FastAPI' | 'Flask'): Promise<string | null> {
  const re = new RegExp(`^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(?::[^=]+)?=\\s*${ctor}\\s*\\(`, 'm');
  for (const file of ['main.py', 'app.py', 'wsgi.py', 'application.py', 'server.py', 'app/main.py', 'src/main.py']) {
    const text = await probe.read(file);
    if (!text) continue;
    const m = re.exec(text);
    if (m) {
      const mod = file.replace(/\.py$/, '').replace(/\//g, '.');
      return `${mod}:${m[1]}`;
    }
  }
  return null;
}

async function pythonVersion(probe: FileProbe): Promise<string> {
  const pv = (await probe.read('.python-version'))?.trim();
  if (pv && /^3\.(9|10|11|12|13)(\.\d+)?$/.test(pv)) return pv.split('.').slice(0, 2).join('.');
  return DEFAULT_PYTHON_VERSION;
}

export async function detectFramework(probe: FileProbe): Promise<Detection> {
  const pkg = safeJson(await probe.read('package.json'));
  const d = base();

  if (pkg) {
    const install = await detectNodeInstall(probe);
    const build = runScript(install);
    if (hasDep(pkg, 'next')) {
      const cfg =
        (await probe.read('next.config.js')) ??
        (await probe.read('next.config.mjs')) ??
        (await probe.read('next.config.ts')) ??
        '';
      const isExport = /output\s*:\s*['"`]export['"`]/.test(cfg);
      return {
        ...d,
        framework: 'NEXTJS',
        label: 'Next.js',
        installCommand: install,
        buildCommand: build,
        outputDirectory: 'out',
        supported: isExport,
        notes: isExport
          ? ['Static export detected (output: "export"); deploying the "out" directory.']
          : [
              'Only static exports of Next.js are supported by this platform version.',
              'Set `output: "export"` in next.config to deploy this project.',
            ],
      };
    }
    if (hasDep(pkg, 'vite')) {
      return { ...d, framework: 'VITE', label: 'Vite', installCommand: install, buildCommand: build, outputDirectory: 'dist', supported: true };
    }
    if (hasDep(pkg, 'react-scripts')) {
      return { ...d, framework: 'REACT', label: 'Create React App', installCommand: install, buildCommand: build, outputDirectory: 'build', supported: true };
    }
    if (hasDep(pkg, 'react')) {
      return {
        ...d,
        framework: 'REACT',
        label: 'React',
        installCommand: install,
        buildCommand: build,
        outputDirectory: 'dist',
        supported: true,
        notes: ['Generic React project detected. Confirm the output directory produced by your build.'],
      };
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    if (scripts.build) {
      return {
        ...d,
        framework: 'OTHER',
        label: 'Node.js (custom build)',
        installCommand: install,
        buildCommand: build,
        outputDirectory: 'dist',
        supported: true,
        notes: ['Custom build detected. Confirm the output directory your build produces.'],
      };
    }
  }

  const py = await pythonDeps(probe);
  if (py) {
    const pyVer = await pythonVersion(probe);
    const usesPyproject = !(await probe.read('requirements.txt')) && (await probe.read('pyproject.toml'));
    const installCommand = usesPyproject ? 'pip install .' : 'pip install -r requirements.txt';
    if (/\bfastapi\b/.test(py)) {
      const entry = (await findEntry(probe, 'FastAPI')) ?? 'main:app';
      return {
        ...d,
        framework: 'FASTAPI',
        label: 'FastAPI',
        runtime: 'PYTHON',
        installCommand,
        pythonVersion: pyVer,
        startCommand: `uvicorn ${entry} --host 0.0.0.0 --port $PORT`,
        supported: true,
        notes: ['Make sure `uvicorn` is listed in your requirements.', 'Expose GET /health returning 200.'],
      };
    }
    if (/\bflask\b/.test(py)) {
      const entry = (await findEntry(probe, 'Flask')) ?? 'app:app';
      return {
        ...d,
        framework: 'FLASK',
        label: 'Flask',
        runtime: 'PYTHON',
        installCommand,
        pythonVersion: pyVer,
        startCommand: `gunicorn ${entry} --bind 0.0.0.0:$PORT`,
        supported: true,
        notes: ['Make sure `gunicorn` is listed in your requirements.', 'Expose GET /health returning 200.'],
      };
    }
  }

  if (await present(probe, 'index.html')) {
    return {
      ...d,
      framework: 'STATIC',
      label: 'Static HTML',
      installCommand: null,
      buildCommand: null,
      outputDirectory: '.',
      supported: true,
      notes: ['No build step: the repository root is published as-is (hidden files are excluded).'],
    };
  }

  return { ...d, notes: ['Could not detect a supported framework. Choose a preset manually.'] };
}

/** A FileProbe over an in-memory map; used by tests and the dev fallback. */
export const memoryProbe = (files: Record<string, string>): FileProbe => ({
  read: async (p) => (p in files ? files[p]! : null),
});
