import { execFile as execFileCb } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS,
  PS_ARGS,
  PS_MAX_BUFFER_BYTES,
  ProcessTableCaptureError,
  SHELL_FOREGROUND_PS_ARGS,
  parseProcessTableRows,
  parseShellForegroundRows,
  parseStrictProcessTableRows,
  type ProcessTableRow
} from './process-table-snapshot'
import { createProcessTableSnapshotReader } from './process-table-snapshot-cache'

export { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS, PS_ARGS, PS_MAX_BUFFER_BYTES }
export { createProcessTableSnapshotReader }

const execFile = promisify(execFileCb)

// Why 15s: the `command=` column costs a per-pid argv read (measured 1.15s for 1,948
// processes; 0.03s without it), and CPU contention multiplies that -- at load 27 the same
// capture measured 1.3-6.0s, so a 3s budget timed out on 6 of 20 consecutive tries and the
// whole subsystem answered "unverifiable" about a table it could read. This keeps a wedged
// `ps` bounded while staying out of reach of a host that is merely busy.
export const PS_TIMEOUT_MS = 15_000

/**
 * Why: `ps` prints lstart in the caller's zone and LC_TIME, and the identity read compares it with
 * a UTC, C-locale read. Pin only time; LC_ALL=C would also rewrite non-ASCII command text.
 */
export function processTableEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const ctype = env.LC_ALL || env.LC_CTYPE || env.LANG
  // Why every locale variable goes: one naming a locale that is not installed (a Linux-spelled
  // LANG, a bogus LC_MESSAGES) drops ps to C, which escapes non-ASCII command text.
  const rest = Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== 'LANG' && !name.startsWith('LC_'))
  )
  return { ...rest, ...(ctype ? { LC_CTYPE: ctype } : {}), LC_TIME: 'C', TZ: 'UTC0' }
}

type ProcessTableCapture = {
  lenient: () => ProcessTableRow[]
  strict: () => ProcessTableRow[]
}

function applyProcessStartTimes(
  rows: ProcessTableRow[],
  startTimesByPid: ReadonlyMap<number, string> | undefined,
  dropUnstableStartTimes = false
): ProcessTableRow[] {
  if ((!startTimesByPid || startTimesByPid.size === 0) && !dropUnstableStartTimes) {
    return rows
  }
  return rows.map((row) => {
    const startTime = startTimesByPid?.get(row.pid)
    if (startTime) {
      return { ...row, startTime }
    }
    if (dropUnstableStartTimes && row.startTime !== undefined) {
      const { startTime: _unstable, ...withoutStartTime } = row
      return withoutStartTime
    }
    return row
  })
}

function createProcessTableCapture(
  stdout: string,
  startTimesByPid?: ReadonlyMap<number, string>,
  dropUnstableStartTimes = false
): ProcessTableCapture {
  let lenientRows: ProcessTableRow[] | null = null
  let strictResult: { rows: ProcessTableRow[] } | { error: unknown } | null = null
  return {
    lenient: () =>
      (lenientRows ??= applyProcessStartTimes(
        parseProcessTableRows(stdout),
        startTimesByPid,
        dropUnstableStartTimes
      )),
    strict: () => {
      if (strictResult === null) {
        try {
          strictResult = {
            rows: applyProcessStartTimes(
              parseStrictProcessTableRows(stdout),
              startTimesByPid,
              dropUnstableStartTimes
            )
          }
        } catch (error) {
          strictResult = { error }
        }
      }
      if ('error' in strictResult) {
        throw strictResult.error
      }
      return strictResult.rows
    }
  }
}

/** Reject captures truncated at the subprocess ceiling or containing no rows. */
function assertWholeCapture(stdout: string): string {
  if (Buffer.byteLength(stdout, 'utf-8') >= PS_MAX_BUFFER_BYTES) {
    throw new ProcessTableCaptureError('capture_truncated')
  }
  if (!/\S/.test(stdout)) {
    throw new ProcessTableCaptureError('empty_capture')
  }
  return stdout
}

/** Field 22 (`starttime`) of `/proc/<pid>/stat`, read past the parenthesised comm. */
export function parseLinuxProcStatStartTime(stat: string): string | null {
  const closingParen = stat.lastIndexOf(')')
  if (closingParen === -1) {
    return null
  }
  const tail = stat
    .slice(closingParen + 1)
    .trim()
    .split(/\s+/)
  return tail[19] || null
}

/** Read Linux's stable PID start-time ticks without spawning another process. */
async function readLinuxProcessStartTimes(
  rows: readonly ProcessTableRow[]
): Promise<ReadonlyMap<number, string> | undefined> {
  if (process.platform !== 'linux') {
    return undefined
  }
  const candidates = rows.filter((row) => row.tty !== undefined && row.tty !== '?')
  const starts = await Promise.all(
    candidates.map(async (row) => {
      try {
        const startTime = parseLinuxProcStatStartTime(
          await readFile(`/proc/${row.pid}/stat`, 'utf8')
        )
        return startTime ? ([row.pid, startTime] as const) : null
      } catch {
        return null
      }
    })
  )
  const result = new Map<number, string>()
  for (const entry of starts) {
    if (entry) {
      result.set(entry[0], entry[1])
    }
  }
  return result
}

async function captureProcessTable(args: readonly string[]): Promise<string> {
  let stdout: string
  try {
    ;({ stdout } = await execFile('ps', [...args], {
      encoding: 'utf-8',
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER_BYTES,
      env: processTableEnv()
    }))
  } catch (error) {
    // A ceiling hit is truncation, not absence: name it in the domain vocabulary.
    if ((error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new ProcessTableCaptureError('capture_truncated')
    }
    throw error
  }
  return assertWholeCapture(stdout)
}

const processTableReader = createProcessTableSnapshotReader<ProcessTableCapture>({
  runPs: async () => {
    const stdout = await captureProcessTable(PS_ARGS)
    const baseCapture = createProcessTableCapture(stdout)
    const startTimesByPid = await readLinuxProcessStartTimes(baseCapture.lenient())
    return createProcessTableCapture(stdout, startTimesByPid, process.platform === 'linux')
  },
  now: () => Date.now()
})

// Its own reader, not a column-set flag on the shared one: terminal-name resolution dominates
// macOS capture time, and a shell proof must not queue behind a full capture it cannot use.
const shellForegroundReader = createProcessTableSnapshotReader<ProcessTableRow[]>({
  runPs: async () => parseShellForegroundRows(await captureProcessTable(SHELL_FOREGROUND_PS_ARGS)),
  now: () => Date.now()
})

export async function getFreshShellForegroundSnapshot(): Promise<ProcessTableRow[]> {
  return process.platform === 'darwin'
    ? shellForegroundReader.getFreshSnapshot()
    : getFreshProcessTableSnapshot()
}

export async function getProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).lenient()
}

/** For a read that answers evidence seen at `notBeforeMs`; see `getSnapshotSince`. */
export async function getProcessTableSnapshotSince(
  notBeforeMs: number,
  stillWanted?: () => boolean
): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshotSince(notBeforeMs, stillWanted)).lenient()
}

export async function getFreshProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getFreshSnapshot()).lenient()
}

export async function getStrictProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).strict()
}

/** How long an evidence-publishing read waits for the shared capture before giving up on it.
 *
 *  Sized from both ends rather than picked. The floor is what the capture costs: the `command=`
 *  column measured 1.15s for 1,948 processes on an idle host, so a budget under that answers
 *  `unverifiable` about a machine nobody is straining. The ceiling is the consumer's --
 *  `REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS` is 2,000ms and a TTL-shared capture may already be
 *  {@link PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS} old when it is served, which leaves 1,500ms,
 *  and transit takes the rest.
 *
 *  Deliberately an order of magnitude below {@link PS_TIMEOUT_MS}, because the two answer
 *  different questions. Identity proof asks whether a process exists and must not read a slow
 *  capture as an absent one, so it waits. These consumers ask whether an observation describes
 *  NOW, and on a host where the capture costs more than this, it does not: the same capture
 *  measured 4.0-18.6s at load 46, and 2.5-9.0s on an idle 2,002-process laptop. A late answer is
 *  rejected by the age gate anyway, having first blocked a polled path for the whole capture, so
 *  a prompt `unverifiable` is both the truthful verdict and the cheaper one. */
export const PROCESS_TABLE_EVIDENCE_BUDGET_MS = 1_200

/** Bounds the WAIT, never the capture. The reader coalesces, so this caller may be joining a
 *  capture some identity probe started under the 15s budget; abandoning the wait leaves that
 *  capture running to fill the cache instead of forking a second whole-machine `ps` on the host
 *  that can least afford one. */
export async function withEvidenceBudget<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ProcessTableCaptureError('capture_over_budget')),
          PROCESS_TABLE_EVIDENCE_BUDGET_MS
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function getStrictProcessTableSnapshotWithAge(): Promise<{
  rows: ProcessTableRow[]
  capturedAgeMs: number
}> {
  const snapshot = await withEvidenceBudget(processTableReader.getSnapshotWithAge())
  return { rows: snapshot.value.strict(), capturedAgeMs: snapshot.capturedAgeMs }
}

export function resetProcessTableSnapshotForTests(): void {
  processTableReader.reset()
  shellForegroundReader.reset()
}
