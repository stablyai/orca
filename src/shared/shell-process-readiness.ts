import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readlink, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PS_MAX_BUFFER_BYTES } from './process-table-snapshot'

const execFile = promisify(execFileCallback)
const PROCESS_READINESS_TIMEOUT_MS = 3000
const DEFAULT_POSIX_EXEC_PATH = '/usr/bin:/bin'

export type ShellProcessReadiness = {
  executablePath: string
  foreground: boolean
}

export function parseDarwinExecutablePath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/)
  const textIndex = lines.indexOf('ftxt')
  const pathLine = textIndex === -1 ? undefined : lines[textIndex + 1]
  return pathLine?.startsWith('n') ? pathLine.slice(1) : null
}

async function readExecutablePath(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    return readlink(`/proc/${pid}/exe`)
  }
  if (process.platform !== 'darwin') {
    return null
  }
  const { stdout } = await execFile(
    '/usr/sbin/lsof',
    ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
    {
      encoding: 'utf8',
      timeout: PROCESS_READINESS_TIMEOUT_MS
    }
  )
  return parseDarwinExecutablePath(stdout)
}

export async function readShellProcessReadiness(
  pid: number
): Promise<ShellProcessReadiness | null> {
  const [executablePath, { stdout }] = await Promise.all([
    readExecutablePath(pid),
    execFile('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      timeout: PROCESS_READINESS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER_BYTES
    })
  ])
  const status = stdout.trim()
  return status && executablePath
    ? { executablePath: await realpath(executablePath), foreground: status.includes('+') }
    : null
}

function shellExecutableCandidates(
  shellPath: string,
  cwd: string,
  pathEnv: string | undefined
): string[] {
  return shellPath.includes('/')
    ? [isAbsolute(shellPath) ? shellPath : resolve(cwd, shellPath)]
    : (
        pathEnv ??
        (process.platform === 'win32' ? (process.env.PATH ?? '') : DEFAULT_POSIX_EXEC_PATH)
      )
        .split(delimiter)
        .map((entry) => resolve(isAbsolute(entry) ? entry : resolve(cwd, entry), shellPath))
}

async function canonicalizeExecutable(candidate: string): Promise<string | null> {
  try {
    await access(candidate, constants.X_OK)
    const canonicalPath = await realpath(candidate)
    return (await stat(canonicalPath)).isFile() ? canonicalPath : null
  } catch {
    return null
  }
}

export async function resolveShellExecutablePath(
  shellPath: string,
  cwd: string,
  pathEnv: string | undefined
): Promise<string | null> {
  for (const candidate of shellExecutableCandidates(shellPath, cwd, pathEnv)) {
    const canonicalPath = await canonicalizeExecutable(candidate)
    if (canonicalPath) {
      return canonicalPath
    }
  }
  return null
}

/** Every canonical executable `shellName` names on `pathEnv` — the installations a
 *  startup profile could legitimately `exec` into, and nothing a dropped-in binary
 *  outside the search path can reach. `shellName` must be a bare name. */
export async function resolveInstalledShellExecutablePaths(
  shellName: string,
  cwd: string,
  pathEnv: string | undefined
): Promise<string[]> {
  const canonicalPaths = await Promise.all(
    shellExecutableCandidates(shellName, cwd, pathEnv).map(canonicalizeExecutable)
  )
  return [...new Set(canonicalPaths.filter((path): path is string => path !== null))]
}

const CHILD_SCAN_TIMEOUT_MS = 3000
/** A figterm-style relay spawns one shell child; a login or hook chain may leave a few
 *  more behind. Everything past this bound is not the shell the relay was started for. */
const MAX_RELAYED_CHILDREN_INSPECTED = 8

async function listImmediateChildPids(pid: number): Promise<number[]> {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    timeout: CHILD_SCAN_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER_BYTES
  })
  const selfPid = String(pid)
  const childPids: number[] = []
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length !== 2 || columns[1] !== selfPid) {
      continue
    }
    const childPid = Number(columns[0])
    if (Number.isSafeInteger(childPid) && childPid > 0) {
      childPids.push(childPid)
      if (childPids.length >= MAX_RELAYED_CHILDREN_INSPECTED) {
        break
      }
    }
  }
  return childPids
}

/** The child's own controlling tty, only while the child is in its foreground group —
 *  the same job-control bar the direct foreground-shell check applies. */
async function readForegroundChildTtyPath(pid: number): Promise<string | null> {
  const { stdout } = await execFile('ps', ['-p', String(pid), '-o', 'stat=,tty='], {
    encoding: 'utf8',
    timeout: PROCESS_READINESS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER_BYTES
  })
  const [status, ttyName] = stdout.trim().split(/\s+/)
  return status?.includes('+') && ttyName && ttyName !== '?' ? `/dev/${ttyName}` : null
}

export type RelayedShellReadiness = {
  /** The relay child's own pty device — a different tty than the pane's slave. */
  ttyPath: string
}

/** The shell behind a figterm-style takeover (#25586): the pane's foreground image is a
 *  relay binary (`kiro-cli-term`, `script`), and the launched shell runs as its child on
 *  the relay's inner pty. Returns the first foreground child that is a legitimate install
 *  of the expected shell — the identical identity standard the direct foreground check
 *  applies, so a non-shell program (a sqlite3 REPL) still finds nothing to release to. */
export async function readRelayedShellReadiness(options: {
  foregroundPid: number
  shellPath: string | undefined
  /** Bare lowercase shell basename; already derived by the caller. */
  shellName: string
  shellCwd?: string
  shellPathEnv?: string
}): Promise<RelayedShellReadiness | null> {
  const expectedPath = options.shellPath
    ? await resolveShellExecutablePath(
        options.shellPath,
        options.shellCwd ?? process.cwd(),
        options.shellPathEnv
      )
    : null
  let installedPaths: string[] | null = null
  for (const childPid of await listImmediateChildPids(options.foregroundPid)) {
    // A listed child can exit before its probes run; skip it and keep scanning.
    try {
      const ttyPath = await readForegroundChildTtyPath(childPid)
      if (!ttyPath) {
        continue
      }
      const executablePath = await readExecutablePath(childPid)
      if (!executablePath) {
        continue
      }
      const canonicalPath = await realpath(executablePath)
      if (basename(canonicalPath).toLowerCase() !== options.shellName) {
        continue
      }
      if (expectedPath && canonicalPath === expectedPath) {
        return { ttyPath }
      }
      installedPaths ??= await resolveInstalledShellExecutablePaths(
        options.shellName,
        options.shellCwd ?? process.cwd(),
        options.shellPathEnv
      )
      if (installedPaths.includes(canonicalPath)) {
        return { ttyPath }
      }
    } catch {
      continue
    }
  }
  return null
}
