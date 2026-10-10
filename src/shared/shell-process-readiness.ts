import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readlink, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
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
