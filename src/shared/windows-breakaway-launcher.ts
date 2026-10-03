/**
 * One-shot launcher mode of `relay.js` and `orcad.js` on Windows SSH hosts: start the detached
 * program outside the SSH session's job object, then exit.
 *
 * Win32-OpenSSH kills a session's job when the session ends. The job allows breakaway, but libuv
 * never asks for it, so the staged process-tree addon does the CreateProcessW. WMI, the old
 * route, is refused to a standard user's network logon, so it is only the relay script's
 * fallback for hosts whose relay predates this addon; orcad has no fallback.
 */
import { renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { quoteWindowsArgument } from './child-process/windows-command-line'
import {
  formatWindowsBreakawayLaunchReport,
  WINDOWS_BREAKAWAY_ENV_FLAG,
  WINDOWS_BREAKAWAY_EXIT_CODES,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
  WINDOWS_BREAKAWAY_STDERR_FLAG,
  WINDOWS_BREAKAWAY_STDOUT_FLAG,
  type WindowsBreakawayLaunchContract,
  type WindowsBreakawayLaunchReport
} from './windows-breakaway-launch'

/** Both bundles stage the addon under this name beside their entry script. */
const WINDOWS_PROCESS_TREE_ADDON = './windows-process-tree.node'

type SpawnOutsideJobResult =
  | { ok: true; pid: number; inJob: boolean }
  | { ok: false; reason: string; step: string; code: number }

export type SpawnOutsideJob = (
  application: string,
  commandLine: string,
  cwd: string,
  stdoutPath: string,
  stderrPath: string
) => SpawnOutsideJobResult

export type WindowsBreakawayLauncher = {
  spawnOutsideJob: SpawnOutsideJob
  /** Null when the addon cannot say, which callers must read as "identity unknown". */
  readCreationTimeMs: (pid: number) => number | null
}

export type WindowsBreakawayLaunchRequest = {
  stdoutPath: string
  stderrPath: string
  processFilePath?: string
  env: Record<string, string>
  programArgs: string[]
}

const ENV_ASSIGNMENT = /^([A-Z_][A-Z0-9_]*)=(.*)$/su
// argv is readable by other users on a shared host; secrets need an owner-only staged file instead.
const SECRET_ENV_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/u

export function parseWindowsBreakawayLaunchRequest(
  contract: WindowsBreakawayLaunchContract,
  argv: readonly string[]
): WindowsBreakawayLaunchRequest | null {
  const flag = argv.indexOf(WINDOWS_BREAKAWAY_LAUNCH_FLAG)
  if (flag === -1) {
    return null
  }
  const separator = argv.indexOf(contract.argsFlag, flag)
  const own = argv.slice(flag + 1, separator === -1 ? argv.length : separator)
  const valueOf = (name: string): string | undefined => {
    const index = own.indexOf(name)
    return index === -1 ? undefined : own[index + 1]
  }
  const required = (name: string): string => {
    const value = valueOf(name)
    if (!value) {
      throw new Error(`${WINDOWS_BREAKAWAY_LAUNCH_FLAG} needs ${name}`)
    }
    return value
  }
  const processFilePath = valueOf(WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG)
  const env: Record<string, string> = {}
  for (const [index, value] of own.entries()) {
    if (value !== WINDOWS_BREAKAWAY_ENV_FLAG) {
      continue
    }
    const assignment = ENV_ASSIGNMENT.exec(own[index + 1] ?? '')
    if (!assignment?.[1]) {
      throw new Error(`${WINDOWS_BREAKAWAY_ENV_FLAG} needs NAME=VALUE`)
    }
    if (SECRET_ENV_NAME.test(assignment[1])) {
      throw new Error(`${WINDOWS_BREAKAWAY_ENV_FLAG} refuses ${assignment[1]}: argv is not secret`)
    }
    env[assignment[1]] = assignment[2] ?? ''
  }
  return {
    stdoutPath: required(WINDOWS_BREAKAWAY_STDOUT_FLAG),
    stderrPath: required(WINDOWS_BREAKAWAY_STDERR_FLAG),
    ...(processFilePath ? { processFilePath } : {}),
    env,
    programArgs: separator === -1 ? [] : argv.slice(separator + 1)
  }
}

/** The staged addon's launcher, or why there is none. */
export function loadWindowsBreakawayLauncher(
  requireNative: (specifier: string) => unknown = createRequire(__filename),
  platform: NodeJS.Platform = process.platform
): WindowsBreakawayLauncher | string {
  if (platform !== 'win32') {
    return 'not-windows'
  }
  let addon: unknown
  try {
    addon = requireNative(WINDOWS_PROCESS_TREE_ADDON)
  } catch {
    return 'addon-missing'
  }
  const record = addon && typeof addon === 'object' ? addon : {}
  const spawn = 'spawnOutsideJob' in record ? record.spawnOutsideJob : undefined
  if (typeof spawn !== 'function') {
    return 'addon-predates-launcher'
  }
  const creationTime =
    'getProcessCreationTime' in record ? record.getProcessCreationTime : undefined
  return {
    spawnOutsideJob: (...args) => readSpawnOutsideJobResult(spawn(...args)),
    readCreationTimeMs: (pid) => {
      const value: unknown = typeof creationTime === 'function' ? creationTime(pid) : undefined
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
    }
  }
}

function readSpawnOutsideJobResult(value: unknown): SpawnOutsideJobResult {
  const record = value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {}
  if (record.ok === true && typeof record.pid === 'number') {
    return { ok: true, pid: record.pid, inJob: record.inJob === true }
  }
  return {
    ok: false,
    reason: typeof record.reason === 'string' ? record.reason : 'unrecognized-result',
    step: typeof record.step === 'string' ? record.step : 'create-process',
    code: typeof record.code === 'number' ? record.code : 0
  }
}

/** Atomic so a reader never sees half a record. */
function writeProcessFile(path: string, contents: string): void {
  const partial = `${path}.partial-${process.pid}`
  writeFileSync(partial, contents)
  renameSync(partial, path)
}

export function launchOutsideJob(
  request: WindowsBreakawayLaunchRequest,
  launcher: WindowsBreakawayLauncher | string,
  runtime: { execPath: string; script: string; cwd: string },
  writeFile: (path: string, contents: string) => void = writeProcessFile
): { report: WindowsBreakawayLaunchReport; exitCode: number } {
  if (typeof launcher === 'string') {
    return {
      report: { method: 'unavailable', reason: launcher },
      exitCode: WINDOWS_BREAKAWAY_EXIT_CODES.unavailable
    }
  }
  const commandLine = [runtime.execPath, runtime.script, ...request.programArgs]
    .map(quoteWindowsArgument)
    .join(' ')
  const result = launcher.spawnOutsideJob(
    runtime.execPath,
    commandLine,
    runtime.cwd,
    request.stdoutPath,
    request.stderrPath
  )
  if (!result.ok) {
    const failure = { reason: result.reason, step: result.step, code: result.code }
    // A job without BREAKAWAY_OK is a host property, not a launch failure.
    return result.reason === 'breakaway-denied'
      ? {
          report: { method: 'unavailable', ...failure },
          exitCode: WINDOWS_BREAKAWAY_EXIT_CODES.unavailable
        }
      : { report: { method: 'failed', ...failure }, exitCode: WINDOWS_BREAKAWAY_EXIT_CODES.failed }
  }
  const creationTimeMs = request.processFilePath ? launcher.readCreationTimeMs(result.pid) : null
  if (request.processFilePath) {
    try {
      writeFile(request.processFilePath, JSON.stringify({ pid: result.pid, creationTimeMs }))
    } catch (error) {
      // Unrecorded, the process could never be proven stopped; the caller must not adopt it.
      const errno =
        error && typeof error === 'object' && 'errno' in error && typeof error.errno === 'number'
          ? error.errno
          : 0
      return {
        report: { method: 'failed', reason: 'process-file', code: errno },
        exitCode: WINDOWS_BREAKAWAY_EXIT_CODES.failed
      }
    }
  }
  return {
    report: {
      method: 'breakaway',
      pid: result.pid,
      inJob: result.inJob,
      ...(creationTimeMs === null ? {} : { creationTimeMs })
    },
    exitCode: WINDOWS_BREAKAWAY_EXIT_CODES.launched
  }
}

/** Runs the launcher mode when argv asks for it; false means run the program normally. */
export function runWindowsBreakawayLaunchIfRequested(
  contract: WindowsBreakawayLaunchContract,
  argv: readonly string[]
): boolean {
  const request = parseWindowsBreakawayLaunchRequest(contract, argv)
  if (!request) {
    return false
  }
  // CreateProcessW gets no environment block, so the child inherits this process's, edits included.
  Object.assign(process.env, request.env)
  const { report, exitCode } = launchOutsideJob(request, loadWindowsBreakawayLauncher(), {
    execPath: process.execPath,
    script: argv[1] ?? '',
    cwd: process.cwd()
  })
  // Why exit: nothing this one-shot mode loaded may keep the launching SSH exec open.
  process.stdout.write(`${formatWindowsBreakawayLaunchReport(contract, report)}\n`, () =>
    process.exit(exitCode)
  )
  return true
}
