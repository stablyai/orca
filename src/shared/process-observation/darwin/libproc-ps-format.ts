import type { LibprocProcessRow } from './libproc-addon'

export const SIDL = 1
const SSTOP = 4
export const SZOMB = 5
const P_CONTROLT = 0x2
const P_PPWAIT = 0x10
const P_SYSTEM = 0x200
const P_TRACED = 0x800
export const P_WEXIT = 0x2000
export const NODEV = -1

/** ps's state letters, except running vs sleeping: that needs another task's thread states (ps is setuid for it), so live processes read `S`. */
export function formatLibprocStat(row: LibprocProcessRow): string {
  const state =
    row.status === SZOMB ? 'Z' : row.status === SSTOP ? 'T' : row.status === SIDL ? 'R' : 'S'
  const nice = row.nice ?? 0
  // adv_cmds ps/print.c state().
  return (
    state +
    (nice < 0 ? '<' : nice > 0 ? 'N' : '') +
    (row.flags & P_TRACED ? 'X' : '') +
    (row.flags & P_WEXIT && row.status !== SZOMB ? 'E' : '') +
    (row.flags & P_PPWAIT ? 'V' : '') +
    (row.flags & P_SYSTEM ? 'L' : '') +
    (row.sessionLeader ? 's' : '') +
    (row.flags & P_CONTROLT && row.pgid === row.tpgid ? '+' : '')
  )
}

export function formatDarwinDevice(tdev: number): string | null {
  return tdev === NODEV ? null : `${(tdev >>> 24) & 0xff}/${tdev & 0xffffff}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** ps `lstart` (`%c` in the C and en_US locales): `Thu Sep  3 16:02:01 2026`. */
export function formatLstart(startSec: number, utc: boolean): string {
  const date = new Date(startSec * 1000)
  const [weekday, month, day, hours, minutes, seconds, year] = utc
    ? [
        date.getUTCDay(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
        date.getUTCFullYear()
      ]
    : [
        date.getDay(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getFullYear()
      ]
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${WEEKDAYS[weekday]} ${MONTHS[month]} ${String(day).padStart(2, ' ')} ${two(hours)}:${two(minutes)}:${two(seconds)} ${year}`
}

const COLUMN_ALIASES: Readonly<Record<string, Column>> = {
  pid: 'pid',
  ppid: 'ppid',
  pgid: 'pgid',
  tpgid: 'tpgid',
  stat: 'stat',
  state: 'stat',
  tdev: 'tdev',
  tty: 'tty',
  lstart: 'lstart',
  command: 'command',
  args: 'command'
}

type Column = 'pid' | 'ppid' | 'pgid' | 'tpgid' | 'stat' | 'tdev' | 'tty' | 'lstart' | 'command'

export type PsQuery = {
  columns: Column[]
  pids: number[] | null
  tty: string | null
}

/** The `ps` invocations Orca issues (`-axo`, `-p`, `-t`, empty headers); anything else returns null and keeps the real ps. */
export function parsePsQuery(args: readonly string[]): PsQuery | null {
  const columns: Column[] = []
  let all = false
  let pids: number[] | null = null
  let tty: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const value = (): string | undefined => args[++index]
    if (arg === '-axo' || arg === '-o') {
      all ||= arg === '-axo'
      const spec = value()
      if (spec === undefined) {
        return null
      }
      for (const field of spec.split(',')) {
        const match = /^([a-z]+)=$/.exec(field)
        const column = match ? COLUMN_ALIASES[match[1]] : undefined
        if (!column) {
          return null
        }
        columns.push(column)
      }
    } else if (arg === '-ax' || arg === '-A') {
      all = true
    } else if (arg === '-ww') {
      continue
    } else if (arg === '-p') {
      const list = value()?.split(',').map(Number)
      if (!list || list.some((pid) => !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)) {
        return null
      }
      // ps keeps each matching process once however often -p names it.
      pids = [...new Set([...(pids ?? []), ...list])]
    } else if (arg === '-t') {
      const name = value()
      // ps -t also takes lists; Orca names one terminal.
      if (!name || tty !== null || /[\s,]/.test(name)) {
        return null
      }
      tty = name
    } else {
      return null
    }
  }
  // ps unions selections; Orca never combines them, so keep the real ps for that.
  const selections = Number(all) + Number(pids !== null) + Number(tty !== null)
  return columns.length > 0 && selections === 1 ? { columns, pids, tty } : null
}

/** ps's pscomp(): terminal, then pid (int subtraction, as C wraps it). */
export function compareLikePs(a: LibprocProcessRow, b: LibprocProcessRow): number {
  return (a.tdev - b.tdev) | 0 || a.pid - b.pid
}
