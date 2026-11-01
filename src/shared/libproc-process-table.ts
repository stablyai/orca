import { nameDarwinTerminalDevices } from './darwin-terminal-names'
import {
  claimDarwinTerminalNaming,
  waitForDarwinTerminalNaming
} from './darwin-terminal-naming-single-flight'
import { loadLibprocAddon, type LibprocProcessRow, type LibprocQuery } from './libproc-addon'
import { DEADLINE_PASSED, beforeDeadline, monotonicNow } from './deadline-settle-notifier'
import {
  isNativeReaderHealthy,
  readFreshNativeTable,
  registerNativeRequest
} from './libproc-native-reads'
import { completeCommands } from './libproc-argv-completion'
import { registerPsFallbackRequest, runPsFallback } from './libproc-ps-fallback'
import {
  compareLikePs,
  formatDarwinDevice,
  formatLibprocStat,
  formatLstart,
  parsePsQuery
} from './libproc-ps-format'

/** Shaped like a process-host ProcessResult so call sites can substitute it for ps's. */
export type LibprocPsResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputTruncated?: boolean
}

export type InProcessPsOptions = {
  /** The environment ps would run with; its TZ and locale shape lstart and command escaping. */
  env?: NodeJS.ProcessEnv
  /** The caller's ps timeout: past it the read resolves timed out, as the killed ps would. */
  timeoutMs: number
  maxOutputBytes?: number
  /** A display poll: any ps it needs waits behind interactive and fresh readers in the fork budget. */
  background?: boolean
  /** Called with when (monotonic ms) the result's oldest recovered argv was read, when that predates this request:
   * evidence built on the result is as old as that input, not as the table read. */
  onArgvReadAt?: (monotonicMs: number) => void
  /** The caller runs its own ps when the in-process reader is down, rather than share the fallback budget, which may
   * time it out (signalling paths that must not lose their read). */
  callerRunsPs?: boolean
}

const TIMED_OUT: LibprocPsResult = {
  code: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true,
  outputTruncated: false
}

/** ps runs setlocale(LC_ALL, ""). */
function localeCategory(env: NodeJS.ProcessEnv, category: 'LC_CTYPE' | 'LC_TIME'): string {
  return env.LC_ALL || env[category] || env.LANG || 'C'
}

function lstartZoneIsUtc(env: NodeJS.ProcessEnv): boolean | null {
  const zone = env.TZ
  if (zone === undefined || zone === process.env.TZ) {
    return false
  }
  return /^(?:UTC|GMT)0?$/.test(zone) ? true : null
}

/** One naming pass at a time: wait out a short one (startup restore) rather than burst /bin/ps; a stalled one
 * returns 'stalled' so the caller runs ps, which names terminals out of process. */
async function nameTerminals(
  devices: ReadonlySet<string>,
  deadline: number
): Promise<ReadonlyMap<string, string> | typeof DEADLINE_PASSED | 'stalled'> {
  for (;;) {
    const controller = new AbortController()
    const naming = claimDarwinTerminalNaming(() =>
      nameDarwinTerminalDevices(devices, undefined, controller.signal)
    )
    if (naming) {
      const named = await beforeDeadline(naming, deadline)
      if (named === DEADLINE_PASSED) {
        controller.abort()
      }
      return named
    }
    const waited = await waitForDarwinTerminalNaming(deadline)
    if (waited !== 'drained') {
      return waited
    }
  }
}

/** Native reads take milliseconds: a signalling caller tries them for this slice, then gives ps its whole
 * original timeout (extending any outer deadline by the slice), so a slow ps succeeds exactly as before. */
export function inProcessSliceMs(timeoutMs: number): number {
  return Math.min(150, Math.floor(timeoutMs / 4))
}

/** The outer-deadline allowance for that slice: none where the in-process reader will not run (Linux, no addon, stalled). */
export function inProcessDeadlineAllowanceMs(timeoutMs: number): number {
  return loadLibprocAddon() && isNativeReaderHealthy() ? inProcessSliceMs(timeoutMs) : 0
}

/** ps output for `args`, read in process, or by one budgeted /bin/ps while the reader is down; null when the addon or
 * the invocation is unsupported (or `callerRunsPs`) so callers run ps. */
export async function runPsInProcess(
  args: readonly string[],
  options: InProcessPsOptions
): Promise<LibprocPsResult | null> {
  const addon = loadLibprocAddon()
  const query = addon ? parsePsQuery(args) : null
  if (!addon || !query) {
    return null
  }
  const registeredSequence = registerNativeRequest()
  const fallbackSequence = registerPsFallbackRequest()
  const requestedAtMs = monotonicNow()
  const deadline = requestedAtMs + options.timeoutMs
  const env = options.env ?? process.env
  // ps gets the caller's whole timeout from the moment the reader gives up, as the caller's own ps did.
  const fallback = async (): Promise<LibprocPsResult | null> =>
    options.callerRunsPs
      ? null
      : runPsFallback(
          args,
          { env, maxOutputBytes: options.maxOutputBytes },
          fallbackSequence,
          monotonicNow() + options.timeoutMs,
          options.background
        )
  const utc = lstartZoneIsUtc(env)
  const needsLstart = query.columns.includes('lstart')
  // lstart is `%c`: only the C and en_US forms are reproduced.
  if (
    needsLstart &&
    (utc === null || !/^(?:C|POSIX|en_US(?:\..*)?)$/.test(localeCategory(env, 'LC_TIME')))
  ) {
    return null
  }
  if (!isNativeReaderHealthy()) {
    return fallback()
  }
  const includeCommand = query.columns.includes('command')
  const ctype = localeCategory(env, 'LC_CTYPE')
  const nativeQuery: LibprocQuery = {
    command: includeCommand,
    ...(query.pids ? { pids: query.pids } : {}),
    ...(query.tty !== null ? { tty: query.tty } : {}),
    ...(includeCommand ? { ctype } : {})
  }
  let rows: LibprocProcessRow[] | null
  let ttyNames: ReadonlyMap<string, string> = new Map()
  try {
    const read = await readFreshNativeTable(addon, nativeQuery, registeredSequence, deadline)
    if (read === 'stalled') {
      return fallback()
    }
    if (read === DEADLINE_PASSED) {
      return TIMED_OUT
    }
    // Shared reads hand every caller the same rows; command completion writes per caller.
    rows = read?.map((row) => ({ ...row })) ?? null
    if (rows && query.columns.includes('tty')) {
      const devices = new Set(
        rows.map((row) => formatDarwinDevice(row.tdev)).filter((device) => device !== null)
      )
      if (devices.size > 0) {
        const named = await nameTerminals(devices, deadline)
        if (named === 'stalled') {
          return fallback()
        }
        if (named === DEADLINE_PASSED) {
          return TIMED_OUT
        }
        ttyNames = named
      }
    }
    if (rows && includeCommand) {
      await completeCommands(
        rows,
        query.pids !== null ? 'pids' : query.tty !== null ? 'tty' : 'all',
        ctype,
        env,
        deadline,
        options.background === true
      )
    }
  } catch {
    return fallback()
  }
  if (monotonicNow() > deadline) {
    return TIMED_OUT
  }
  const argvReadAt = Math.min(...(rows ?? []).map((row) => row.commandReadAtMs ?? Infinity))
  if (argvReadAt < requestedAtMs) {
    options.onArgvReadAt?.(argvReadAt)
  }
  // ps exits 1 when -t names no terminal or a -p/-t selection matched nothing.
  if (rows === null) {
    return { ...TIMED_OUT, code: 1, signal: null, timedOut: false }
  }
  const ttyOf = (row: LibprocProcessRow): string =>
    ttyNames.get(formatDarwinDevice(row.tdev) ?? '') ?? '??'
  const selected = rows.sort(compareLikePs)
  const lines = selected.map((row) =>
    query.columns
      .map((column) => {
        switch (column) {
          case 'stat':
            return formatLibprocStat(row)
          case 'tdev':
            return formatDarwinDevice(row.tdev) ?? '??'
          case 'tty':
            return ttyOf(row)
          case 'lstart':
            return formatLstart(row.startSec, utc === true)
          case 'command':
            return row.command ?? `(${row.comm})`
          case 'pid':
          case 'ppid':
          case 'pgid':
          case 'tpgid':
            return String(row[column])
        }
      })
      .join(' ')
  )
  let stdout = lines.length > 0 ? `${lines.join('\n')}\n` : ''
  const maxBytes = options.maxOutputBytes
  const outputTruncated = maxBytes !== undefined && Buffer.byteLength(stdout, 'utf8') > maxBytes
  if (outputTruncated) {
    stdout = Buffer.from(stdout, 'utf8').subarray(0, maxBytes).toString('utf8')
  }
  return {
    code: query.pids === null && query.tty === null ? 0 : selected.length > 0 ? 0 : 1,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    outputTruncated
  }
}

function stdoutLikeExecFile(args: readonly string[], result: LibprocPsResult): string {
  if (result.timedOut || result.code !== 0) {
    throw Object.assign(
      new Error(
        `Command failed: ps ${args.join(' ')}${result.timedOut ? ' (timed out)' : ''}\n${result.stderr}`
      ),
      { code: result.code, killed: result.timedOut, signal: result.signal }
    )
  }
  if (result.outputTruncated) {
    throw Object.assign(new Error(`ps ${args.join(' ')} exceeded maxBuffer`), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    })
  }
  return result.stdout
}

/** execFile-shaped: rejects on a nonzero exit or timeout like a failed ps child; null when ps must run. */
export async function readPsStdoutInProcess(
  args: readonly string[],
  options: InProcessPsOptions
): Promise<string | null> {
  const result = await runPsInProcess(args, options)
  return result ? stdoutLikeExecFile(args, result) : null
}

/** execFile-shaped /bin/ps through the shared fork budget, for captures that must run ps (a held naming pass);
 * only a ps spawned after this call answers it. */
export async function readPsStdoutBudgeted(
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    timeoutMs: number
    maxOutputBytes?: number
    background?: boolean
  }
): Promise<string> {
  const registered = registerPsFallbackRequest()
  const result = await runPsFallback(
    args,
    { env: options.env, maxOutputBytes: options.maxOutputBytes },
    registered,
    monotonicNow() + options.timeoutMs,
    options.background
  )
  return stdoutLikeExecFile(args, result)
}
