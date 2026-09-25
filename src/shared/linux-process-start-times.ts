import { readFile } from 'node:fs/promises'
import type { ProcessTableRow } from './process-table-snapshot'

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
export async function readLinuxProcessStartTimes(
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
