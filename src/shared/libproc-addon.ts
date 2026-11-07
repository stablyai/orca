import { createRequire } from 'node:module'
import { DEADLINE_PASSED, beforeDeadline, monotonicNow } from './deadline-settle-notifier'

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
  /** Effective uid (`cr_uid`), which decides whether KERN_PROCARGS2 may read argv. */
  uid?: number
  sessionLeader: boolean
  startSec: number
  /** `p_starttime.tv_usec`, telling apart processes a reused pid started within one second. */
  startUsec?: number
  comm: string
  /** ps's command text (getproclline + strvis in the query's LC_CTYPE). */
  command?: string
  /** Set by argv recovery, not the addon: monotonic ms no later than setuid ps read `command`, so ages never understate. */
  commandReadAtMs?: number
  /** argv was unreadable (another user's, exiting or mid-exec): `command` holds `(comm)`, where setuid ps may print argv. */
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
  /** PROC_PIDVNODEPATHINFO and proc_pidpath can block on a dead network mount, so both run on a worker thread.
   * Absent from a #35987 pty.node, which still reads the table: cwd and path then come from lsof. */
  readProcessCwd?: (pid: number) => Promise<string | null>
  readProcessPath?: (pid: number) => Promise<string | null>
}

const requireFromHere = createRequire(__filename)
let cachedAddon: LibprocAddon | null | undefined
let addonOverride: LibprocAddon | null | undefined

function hasAsyncPathReads(addon: LibprocAddon): boolean {
  return typeof addon.readProcessCwd === 'function' && typeof addon.readProcessPath === 'function'
}

function isLibprocAddon(native: unknown): native is LibprocAddon {
  return (
    typeof native === 'object' &&
    native !== null &&
    'readProcessTable' in native &&
    typeof native.readProcessTable === 'function'
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
    // An older pty.node exports positional processTable() instead; it must not match. Its synchronous processCwd and
    // processPath are never called: they can block the event loop on a dead mount.
    cachedAddon = isLibprocAddon(native) ? native : null
    if (cachedAddon && !hasAsyncPathReads(cachedAddon)) {
      console.warn('[process-table] node-pty lacks the async cwd/path reader; using lsof for those')
    }
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

// A lookup stuck on a dead mount pins its worker thread in the kernel; cap them so the rest of the libuv pool stays free.
const MAX_OUTSTANDING_PATH_READS = 2
// Path lookups take microseconds; past this the mount is wedged and lsof -b answers instead. lsof can block in the same
// PROC_PIDVNODEPATHINFO, but in a child process (one per pid), not on this process's thread pool.
const PATH_READ_TIMEOUT_MS = 250
let outstandingPathReads = 0

/** cwd or executable path read in process, or undefined when only lsof can answer (no addon, a slow or wedged lookup). */
export async function readLibprocProcessFilePath(
  which: 'cwd' | 'executable',
  pid: number
): Promise<string | null | undefined> {
  const addon = loadLibprocAddon()
  const read = which === 'cwd' ? addon?.readProcessCwd : addon?.readProcessPath
  if (!read || outstandingPathReads >= MAX_OUTSTANDING_PATH_READS) {
    return undefined
  }
  let pending: Promise<string | null>
  try {
    pending = read(pid)
  } catch {
    return undefined
  }
  outstandingPathReads += 1
  const release = (): void => {
    outstandingPathReads -= 1
  }
  pending.then(release, release)
  try {
    const path = await beforeDeadline(pending, monotonicNow() + PATH_READ_TIMEOUT_MS)
    return path === DEADLINE_PASSED ? undefined : path
  } catch {
    return undefined
  }
}
