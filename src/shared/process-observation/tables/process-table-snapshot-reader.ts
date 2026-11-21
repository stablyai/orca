import { readFile } from 'node:fs/promises'
import { monotonicNow } from '../../concurrency/deadline-settle-notifier'
import { PS_TIMEOUT_MS, assertWholeCapture, captureProcessTable } from './process-table-ps-capture'
import {
  captureDarwinProcessTable,
  resetDarwinProcessTableCaptureForTests
} from '../darwin/darwin-process-table-capture'
import {
  PS_ARGS,
  ProcessTableCaptureError,
  SHELL_FOREGROUND_PS_ARGS,
  parseProcessTableRows,
  parseShellForegroundRows,
  parseStrictProcessTableRows,
  type ProcessTableRow
} from './process-table-snapshot'

import { createProcessTableSnapshotReader } from './process-snapshot-cache'

export { createProcessTableSnapshotReader } from './process-snapshot-cache'

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
): Promise<ReadonlyMap<number, string>> {
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
  return new Map(starts.filter((entry) => entry !== null))
}

/** Recovered argv reports monotonic read times; the snapshot readers stamp ages on the wall clock. */
function onArgvReadAt(inputAt: (atMs: number) => void): (monotonicMs: number) => void {
  return (monotonicMs) => inputAt(Date.now() - (monotonicNow() - monotonicMs))
}

const processTableReader = createProcessTableSnapshotReader<ProcessTableCapture>({
  runPs: async (fresh, inputAt) => {
    const stdout =
      process.platform === 'darwin'
        ? await captureDarwinProcessTable(
            (args, timeout, ps) =>
              captureProcessTable(args, timeout, ps, !fresh, onArgvReadAt(inputAt)),
            assertWholeCapture,
            PS_TIMEOUT_MS
          )
        : await captureProcessTable(PS_ARGS)
    if (process.platform !== 'linux') {
      return createProcessTableCapture(stdout)
    }
    const startTimesByPid = await readLinuxProcessStartTimes(parseProcessTableRows(stdout))
    return createProcessTableCapture(stdout, startTimesByPid, true)
  },
  now: () => Date.now()
})

// Separate shell reader avoids macOS terminal-name costs and waiting on full captures it cannot use.
const shellForegroundReader = createProcessTableSnapshotReader<ProcessTableRow[]>({
  runPs: async (fresh, inputAt) =>
    parseShellForegroundRows(
      await captureProcessTable(
        SHELL_FOREGROUND_PS_ARGS,
        PS_TIMEOUT_MS,
        false,
        !fresh,
        onArgvReadAt(inputAt)
      )
    ),
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

export async function getFreshProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getFreshSnapshot()).lenient()
}

export async function getStrictProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).strict()
}

/** Evidence needs current observations, unlike identity probes that wait up to 15s. Idle command= costs ~1.15s/1,948 processes;
 * 2s freshness ceiling minus up to 500ms cached age and transit leaves 1.2s. Slower captures fail age gates anyway
 * (measured 4–18.6s at load 46, 2.5–9s on a 2,002-process laptop), so return unverifiable promptly. */
export const PROCESS_TABLE_EVIDENCE_BUDGET_MS = 1_200

/** Bound only this wait; leave shared identity captures running to fill the cache instead of spawning another expensive ps. */
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

/** Rows of a full capture already cached or under way, so cheaper readers can use it instead of reading again. */
export function peekStrictProcessTableSnapshot(): Promise<ProcessTableRow[]> | null {
  return processTableReader.peekSnapshot()?.then((capture) => capture.strict()) ?? null
}

export async function getStrictProcessTableSnapshotWithAge(afterMs?: number): Promise<{
  rows: ProcessTableRow[]
  capturedAgeMs: number
}> {
  const budget =
    afterMs === undefined ? undefined : AbortSignal.timeout(PROCESS_TABLE_EVIDENCE_BUDGET_MS)
  const snapshot = await withEvidenceBudget(processTableReader.getSnapshotWithAge(afterMs, budget))
  return { rows: snapshot.value.strict(), capturedAgeMs: snapshot.capturedAgeMs }
}

export function resetProcessTableSnapshotForTests(): void {
  processTableReader.reset()
  shellForegroundReader.reset()
  resetDarwinProcessTableCaptureForTests()
}
