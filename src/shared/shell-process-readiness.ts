import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readlink, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { LSOF_NONBLOCKING_ARGS } from './lsof-nonblocking-args'
import { readLibprocProcessPath } from './libproc-addon'
import { readPsStdoutInProcess } from './libproc-process-table'
import { PS_MAX_BUFFER_BYTES } from './process-table-snapshot'

const execFile = promisify(execFileCallback)
const PROCESS_READINESS_TIMEOUT_MS = 3000
const DEFAULT_POSIX_EXEC_PATH = '/usr/bin:/bin'

export type ShellProcessReadiness = {
  executablePath: string
  foreground: boolean
  ttyPath: string | null
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
  const inProcess = readLibprocProcessPath(pid)
  if (inProcess !== undefined) {
    return inProcess
  }
  const { stdout } = await execFile(
    '/usr/sbin/lsof',
    [...LSOF_NONBLOCKING_ARGS, '-a', '-p', String(pid), '-d', 'txt', '-Fn'],
    {
      encoding: 'utf8',
      timeout: PROCESS_READINESS_TIMEOUT_MS
    }
  )
  return parseDarwinExecutablePath(stdout)
}

/** Rejects like execFile when ps exits nonzero, so callers keep their error paths. */
async function readPs(args: string[]): Promise<string> {
  const inProcess = await readPsStdoutInProcess(args, {
    timeoutMs: PROCESS_READINESS_TIMEOUT_MS,
    maxOutputBytes: PS_MAX_BUFFER_BYTES
  })
  if (inProcess !== null) {
    return inProcess
  }
  const { stdout } = await execFile('ps', args, {
    encoding: 'utf8',
    timeout: PROCESS_READINESS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER_BYTES
  })
  return stdout
}

export async function readShellProcessReadiness(
  pid: number
): Promise<ShellProcessReadiness | null> {
  const [executablePath, stdout] = await Promise.all([
    readExecutablePath(pid),
    readPs(['-p', String(pid), '-o', 'stat=,tty='])
  ])
  const [status, ttyName] = stdout.trim().split(/\s+/)
  return status && executablePath
    ? {
        executablePath: await realpath(executablePath),
        foreground: status.includes('+'),
        ttyPath: ttyName && ttyName !== '?' && ttyName !== '??' ? `/dev/${ttyName}` : null
      }
    : null
}

export async function listChildProcessIds(pid: number): Promise<number[]> {
  const stdout = await readPs(['-axo', 'pid=,ppid='])
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([childPid, parentPid]) => childPid && parentPid === String(pid))
    .map(([childPid]) => Number(childPid))
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

/** Resolve all PATH-installed canonical shell executables a startup profile could exec into; reject non-bare shellName inputs. */
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
