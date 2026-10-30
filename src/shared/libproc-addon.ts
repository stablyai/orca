import { createRequire } from 'node:module'

/** One `kinfo_proc` from node-pty's patched macOS addon (config/patches/node-pty@1.1.0.patch). */
export type LibprocProcessRow = {
  pid: number
  ppid: number
  pgid: number
  tpgid: number
  /** `e_tdev`; -1 (NODEV) without a controlling terminal. */
  tdev: number
  /** `p_stat`: SIDL 1, SRUN 2, SSLEEP 3, SSTOP 4, SZOMB 5. */
  status: number
  flags: number
  /** `p_nice`; absent from older builds. */
  nice?: number
  sessionLeader: boolean
  startSec: number
  /** `p_starttime.tv_usec`, telling apart processes a reused pid started within one second. */
  startUsec?: number
  comm: string
  /** ps's command text (getproclline + strvis in the query's LC_CTYPE). */
  command?: string
  /** argv was unreadable (another user's process): `command` holds the executable path, where setuid ps prints argv. */
  commandIncomplete?: boolean
}

/** `pids` and `tty` are exclusive; `tty` follows ps -t naming. Null when the terminal does not exist. */
export type LibprocQuery = {
  command: boolean
  pids?: readonly number[]
  tty?: string
  ctype?: string
}

export type LibprocAddon = {
  /** Reads on a libuv worker thread; argv for a whole table costs ~20ms of syscalls. */
  readProcessTable: (query: LibprocQuery) => Promise<LibprocProcessRow[] | null>
  processCwd: (pid: number) => string | null
  processPath: (pid: number) => string | null
}

const requireFromHere = createRequire(__filename)
let cachedAddon: LibprocAddon | null | undefined
let addonOverride: LibprocAddon | null | undefined

function isLibprocAddon(native: unknown): native is LibprocAddon {
  return (
    typeof native === 'object' &&
    native !== null &&
    'readProcessTable' in native &&
    typeof native.readProcessTable === 'function' &&
    'processCwd' in native &&
    typeof native.processCwd === 'function' &&
    'processPath' in native &&
    typeof native.processPath === 'function'
  )
}

/** The in-process reader, or null where ps/lsof must still run (non-macOS, an unpatched or unloadable node-pty).
 * Vitest keeps the subprocess path so ps fixtures stay authoritative. */
export function loadLibprocAddon(): LibprocAddon | null {
  if (addonOverride !== undefined) {
    return addonOverride
  }
  if (process.platform !== 'darwin' || process.env.VITEST === 'true') {
    return null
  }
  if (cachedAddon !== undefined) {
    return cachedAddon
  }
  try {
    const utils: unknown = requireFromHere('node-pty/lib/utils')
    const native: unknown =
      typeof utils === 'object' &&
      utils !== null &&
      'loadNativeModule' in utils &&
      typeof utils.loadNativeModule === 'function'
        ? utils.loadNativeModule('pty')?.module
        : null
    // An older pty.node exports positional processTable() instead; it must not match.
    cachedAddon = isLibprocAddon(native) ? native : null
  } catch {
    cachedAddon = null
  }
  if (cachedAddon === null) {
    // A packaging regression would otherwise silently restore one setuid ps exec per poll (#31783).
    console.warn('[process-table] node-pty lacks the libproc reader; falling back to ps and lsof')
  }
  return cachedAddon
}

export function setLibprocAddonForTests(addon: LibprocAddon | null | undefined): void {
  addonOverride = addon
}

/** PROC_PIDVNODEPATHINFO cwd, or undefined when only lsof can answer. */
export function readLibprocProcessCwd(pid: number): string | null | undefined {
  const addon = loadLibprocAddon()
  if (!addon) {
    return undefined
  }
  try {
    return addon.processCwd(pid)
  } catch {
    return undefined
  }
}

/** proc_pidpath executable, or undefined when only lsof can answer. */
export function readLibprocProcessPath(pid: number): string | null | undefined {
  const addon = loadLibprocAddon()
  if (!addon) {
    return undefined
  }
  try {
    return addon.processPath(pid)
  } catch {
    return undefined
  }
}
