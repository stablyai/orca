/**
 * AppEnvironment abstracts the host-process facilities Orca's core reads from
 * Electron's `app` (data paths, version, packaged flag, lifecycle). The desktop
 * app installs an Electron-backed implementation; the headless `@stablyai/orca-server`
 * installs a plain-Node one so the runtime core never imports `electron`.
 *
 * Why a settable singleton rather than constructor injection: `app.getPath` and
 * friends are read at module scope and through deep call chains, so threading an
 * instance everywhere would be a large, risky change. The Electron default keeps
 * desktop behavior byte-identical; the node entrypoint overrides it once at boot.
 */
import type * as NodeOs from 'node:os'
import type * as NodePath from 'node:path'

export type AppPathName =
  | 'userData'
  | 'home'
  | 'appData'
  | 'temp'
  | 'downloads'
  | 'logs'
  | 'exe'

export type AppEnvironment = {
  /** Mirrors electron app.getPath. `userData` is the load-bearing one. */
  getPath(name: AppPathName): string
  /** Mirrors electron app.getAppPath() — the install/bundle root. */
  getAppPath(): string
  getVersion(): string
  isPackaged(): boolean
  /** Register a shutdown hook (electron 'will-quit' / Node SIGTERM/SIGINT). */
  onWillQuit(handler: () => void): void
  quit(): void
  exit(code?: number): void
  /** Best-effort relaunch; a node server treats this as exit-for-supervisor. */
  relaunch(): void
  /**
   * Per-process Chromium metrics (electron app.getAppMetrics). Electron-only
   * diagnostics with no Node equivalent — the node server returns []. Typed
   * loosely to avoid pulling Electron types into shared code.
   */
  getAppMetrics(): AppProcessMetric[]
}

/** Loose mirror of electron's ProcessMetric so shared code stays Electron-free. */
export type AppProcessMetric = {
  pid: number
  type?: string
  cpu?: { percentCPUUsage?: number }
  memory?: { workingSetSize?: number; privateBytes?: number }
  [key: string]: unknown
}

let current: AppEnvironment | null = null

/**
 * Install the active environment. The Electron main process and the node server
 * entrypoint each call this once before any consumer resolves a path.
 */
export function setAppEnvironment(env: AppEnvironment): void {
  current = env
}

export function getAppEnvironment(): AppEnvironment {
  if (!current) {
    // Under vitest, modules are frequently re-imported via vi.resetModules(),
    // which gives this module a fresh (uninitialized) singleton. Lazily install
    // a benign default so tests don't each have to re-wire it; production never
    // sets VITEST and must call setAppEnvironment() explicitly.
    if (process.env.VITEST) {
      current = createTestDefaultAppEnvironment()
      return current
    }
    throw new Error(
      'AppEnvironment not initialized — call setAppEnvironment() before resolving app paths'
    )
  }
  return current
}

// Why: keep the test default in this module (not the consumer) so any reset-then-
// reimport path gets a working environment without importing node-only helpers
// into shared code. Uses a temp-dir userData and env-derived version.
function createTestDefaultAppEnvironment(): AppEnvironment {
  // Lazy require keeps node built-ins out of this shared module's load graph;
  // typed via the top-level `import type` aliases so no inline import() is needed.
  const os: typeof NodeOs = require('node:os')
  const path: typeof NodePath = require('node:path')
  const userData = process.env.ORCA_USER_DATA_PATH ?? path.join(os.tmpdir(), 'orca-vitest-userdata')
  return {
    getPath: (name) => {
      switch (name) {
        case 'userData':
          return userData
        case 'home':
          return os.homedir()
        case 'temp':
          return os.tmpdir()
        default:
          return path.join(userData, name)
      }
    },
    getAppPath: () => process.cwd(),
    getVersion: () => process.env.ORCA_APP_VERSION ?? '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    quit: () => {},
    exit: () => {},
    relaunch: () => {},
    getAppMetrics: () => []
  }
}

export function hasAppEnvironment(): boolean {
  return current !== null
}

/** Test-only reset so suites can install a fake without leaking across files. */
export function __resetAppEnvironmentForTests(): void {
  current = null
}
