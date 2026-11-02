/** Install Electron/Node host facilities before core modules resolve paths, keeping core Electron-free. A singleton supports module-scope/deep reads; existing injected ports stay injected. No node imports: shared enters the web build graph; Node callers install explicit defaults. */

export type AppPathName = 'userData' | 'home' | 'appData' | 'temp' | 'downloads' | 'logs' | 'exe'

export type AppEnvironment = {
  /** Mirrors electron `app.getPath`. `userData` is the load-bearing one. */
  getPath(name: AppPathName): string
  /** Mirrors electron `app.getAppPath()` — the install/bundle root. */
  getAppPath(): string
  getVersion(): string
  isPackaged(): boolean
  /** A headless host's profile-scoped CLI, when it has no Electron resources directory. */
  getCliLauncherPath?(): string | null
  /** Shutdown hook: electron `will-quit`, or SIGTERM/SIGINT on a Node host. */
  onWillQuit(handler: () => void): void
  exit(code?: number): void
  /** Return no Chromium metrics on Node. Keep this on the port because its sole consumer, memory/collector.ts, reads at module scope. */
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

/** Anchor to the realm via a global symbol so vi.resetModules cannot lose an environment installed before reimport. */
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

/** Let desktop/Node-fork callers check availability when no app root is legitimate and should mean null. */
export function hasAppEnvironment(): boolean {
  return read() !== null
}

export function getAppEnvironment(): AppEnvironment {
  const current = read()
  if (!current) {
    // Fail at the first missing install instead of silently writing user state to the wrong userData directory.
    throw new Error(
      'AppEnvironment not initialized — call setAppEnvironment() during startup before resolving app paths'
    )
  }
  return current
}
