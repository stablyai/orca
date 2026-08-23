/**
 * AppEnvironment abstracts the host-process facilities Orca's core reads from
 * Electron's `app`: data paths, version, packaged flag, and shutdown. The
 * desktop installs an Electron-backed implementation; a plain-Node host (the
 * headless runtime server) installs a Node one, so core modules never import
 * `electron`.
 *
 * Why a settable singleton rather than constructor injection: `getPath('userData')`
 * is read at module scope and through deep call chains in ~17 modules. Threading
 * an instance through all of them would be a rewrite, not a refactor. Ports that
 * already have an injection point (the browser backend) stay injected instead.
 *
 * This module must stay free of `node:` imports — `src/shared/**` is in the web
 * build graph (config/tsconfig.tc.web.json), so a require() here ships to the
 * renderer. Callers that need a Node-flavoured default install one explicitly.
 */

export type AppPathName = 'userData' | 'home' | 'appData' | 'temp' | 'downloads' | 'logs' | 'exe'

export type AppEnvironment = {
  /** Mirrors electron `app.getPath`. `userData` is the load-bearing one. */
  getPath(name: AppPathName): string
  /** Mirrors electron `app.getAppPath()` — the install/bundle root. */
  getAppPath(): string
  getVersion(): string
  isPackaged(): boolean
  /** Shutdown hook: electron `will-quit`, or SIGTERM/SIGINT on a Node host. */
  onWillQuit(handler: () => void): void
  exit(code?: number): void
  /**
   * Per-process Chromium metrics (electron `app.getAppMetrics`). A Node host has
   * no Chromium processes to measure and returns []. Kept on the port rather than
   * injected because `src/main/memory/collector.ts` is its only caller and reads
   * it from module scope.
   */
  getAppMetrics(): AppProcessMetric[]
}

/** Loose structural mirror of electron's ProcessMetric, so shared code stays Electron-free. */
export type AppProcessMetric = {
  pid: number
  type?: string
  cpu?: { percentCPUUsage?: number }
  memory?: { workingSetSize?: number; privateBytes?: number }
  [key: string]: unknown
}

/**
 * Why a global symbol and not a module-level `let`: `vi.resetModules()` gives the
 * re-imported graph a fresh copy of this module, so an environment installed before the
 * reset would silently read back as uninstalled. Anchoring to the realm keeps one
 * instance per process however often the module registry is rebuilt.
 */
const SLOT = Symbol.for('orca.host.appEnvironment')

type Slot = { [SLOT]?: AppEnvironment | null }

function slot(): Slot {
  return globalThis as unknown as Slot
}

function read(): AppEnvironment | null {
  return slot()[SLOT] ?? null
}

/** Install the active environment. Each entrypoint calls this once, before any consumer resolves a path. */
export function setAppEnvironment(environment: AppEnvironment): void {
  slot()[SLOT] = environment
}

/**
 * Whether an environment is installed. For callers that must work in BOTH the desktop
 * and a plain-Node fork — those legitimately have no app root and want null, not a throw.
 */
export function hasAppEnvironment(): boolean {
  return read() !== null
}

export function getAppEnvironment(): AppEnvironment {
  const current = read()
  if (!current) {
    // Why throw rather than fall back: a silent default answers `userData` with the
    // wrong directory, and the caller writes real user state there before anyone
    // notices. Failing at the first read makes a missing install() obvious.
    throw new Error(
      'AppEnvironment not initialized — call setAppEnvironment() during startup before resolving app paths'
    )
  }
  return current
}
