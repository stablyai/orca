import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { recognizeAgentProcess, type RecognizedAgentProcess } from './agent-process-recognition'

const execFile = promisify(execFileCb)

// Why: resolving a PID's real executable image forks lsof (macOS) or reads
// /proc (Linux). Foreground scans on the completion cadence re-inspect the same
// unrecognized pane, so cache the resolved path per PID behind a short TTL. No
// process start-time in the key (not cheaply available cross-platform): a
// recycled PID could serve a stale path for at most one TTL window, but the
// caller re-runs pure agent recognition on it, so a mismatch merely fails to
// recognize instead of mislabeling.
const EXECUTABLE_PATH_CACHE_TTL_MS = 5_000
const EXECUTABLE_PATH_LOOKUP_TIMEOUT_MS = 3_000

export type ProcessExecutablePathDeps = {
  platform?: NodeJS.Platform
  readLinuxExecutable?: (pid: number) => Promise<string | null>
  readMacExecutable?: (pid: number) => Promise<string | null>
  now?: () => number
}

const executablePathCache = new Map<number, { path: string | null; at: number }>()

/**
 * Resolve a process's real executable image path by PID. Linux reads
 * `/proc/PID/exe`; macOS uses `lsof -d txt` (the executable image fds). Returns
 * null on unsupported platforms or when the lookup fails. Cached per PID.
 */
export async function resolveProcessExecutablePath(
  pid: number,
  deps: ProcessExecutablePathDeps = {}
): Promise<string | null> {
  const now = (deps.now ?? Date.now)()
  const cached = executablePathCache.get(pid)
  if (cached && now - cached.at < EXECUTABLE_PATH_CACHE_TTL_MS) {
    return cached.path
  }
  const platform = deps.platform ?? process.platform
  let path: string | null = null
  if (platform === 'linux') {
    path = await (deps.readLinuxExecutable ?? readLinuxProcExe)(pid)
  } else if (platform === 'darwin') {
    path = await (deps.readMacExecutable ?? readMacExecutableImage)(pid)
  }
  executablePathCache.set(pid, { path, at: now })
  return path
}

/**
 * Recognize a renamed/forked agent binary from its real executable image: an
 * argv0-renamed real binary or a native fork at a non-standard path shows an
 * unrecognized command line, but its executable basename can still identify the
 * agent. Interpreter forks (node/python launching a script) resolve to the
 * interpreter and stay unrecognized here — script CLIs are covered by the
 * existing argv/entrypoint recognition instead.
 */
export async function recognizeAgentFromExecutablePath(
  pid: number,
  deps: ProcessExecutablePathDeps = {}
): Promise<RecognizedAgentProcess | null> {
  const executablePath = await resolveProcessExecutablePath(pid, deps)
  return executablePath ? recognizeAgentProcess(executablePath) : null
}

async function readLinuxProcExe(pid: number): Promise<string | null> {
  // Why: skip an existsSync gate — the check+read pair races a concurrent exit
  // anyway, and the catch already yields null. Mirrors resolveProcessCwd.
  try {
    const { readlinkSync } = await import('node:fs')
    return readlinkSync(`/proc/${pid}/exe`)
  } catch {
    return null
  }
}

async function readMacExecutableImage(pid: number): Promise<string | null> {
  // Why: `-d txt` limits lsof to text (executable image) fds and `-a` ANDs it
  // with `-p` so only THIS pid's entries return — the same same-uid per-PID
  // pattern as resolveProcessCwd. macOS lists the main executable image as the
  // first txt entry (mapped dylibs follow), so the first `n/…` line is the
  // image; later entries are ignored defensively.
  try {
    const { stdout } = await execFile('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
      encoding: 'utf-8',
      timeout: EXECUTABLE_PATH_LOOKUP_TIMEOUT_MS
    })
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.includes('/')) {
        return line.slice(1)
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Test-only: clear the per-PID executable-path cache so suites that mock the
 * readers between cases don't have one case's path served to the next.
 */
export function resetProcessExecutablePathCacheForTests(): void {
  executablePathCache.clear()
}
