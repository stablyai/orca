import { runProcess } from '@orca/process-host'
import type { LibprocProcessRow } from './libproc-addon'
import { monotonicNow } from './deadline-settle-notifier'
import { NODEV } from './libproc-ps-format'

const SZOMB_STATUS = 5
const MAX_ANCESTOR_DEPTH = 64

/** A pane descendant: the unreadable chain above it starts on the terminal of one of the user's own (argv-readable)
 * processes, e.g. `sudo` under the pane shell, and the root shell and agent `sudo -i` puts on its own pty (use_pty).
 * Root daemons descend only from launchd, and a pane's root `login` opens its own pty under the terminal host, so
 * neither costs a ps. */
function descendsFromUsersTerminal(
  row: LibprocProcessRow,
  byPid: ReadonlyMap<number, LibprocProcessRow>
): boolean {
  let top = row
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = top.pid === top.ppid ? undefined : byPid.get(top.ppid)
    if (!parent) {
      return false
    }
    if (!parent.commandIncomplete) {
      return parent.tdev !== NODEV && parent.tdev === top.tdev
    }
    top = parent
  }
  return false
}

type AuthoritativeCommand = { command: string; cachedAtMs: number }

// exec can keep pid, start time, comm and executable (node → node with another script) and no cheap field shows it,
// so a recovered argv is trusted for 30s: a sudo pane costs one targeted ps per process per TTL, other users none.
const authoritativeCommands = new Map<string, AuthoritativeCommand>()
const AUTHORITATIVE_COMMAND_LIMIT = 512
const AUTHORITATIVE_COMMAND_TTL_MS = 30_000

/** exec keeps pid and start time but changes comm and the executable path; microseconds split same-second pid reuse. */
function commandKey(ctype: string, row: LibprocProcessRow): string {
  return [ctype, row.pid, row.startSec, row.startUsec ?? '', row.comm, row.command ?? ''].join('\0')
}

function rememberCommand(key: string, command: string, now: number): void {
  authoritativeCommands.delete(key)
  for (const oldest of authoritativeCommands.keys()) {
    if (authoritativeCommands.size < AUTHORITATIVE_COMMAND_LIMIT) {
      break
    }
    authoritativeCommands.delete(oldest)
  }
  authoritativeCommands.set(key, { command, cachedAtMs: now })
}

/** Fill argv only setuid ps can read, for the rows this caller selected or that descend from a user's terminal. */
export async function completeCommands(
  rows: LibprocProcessRow[],
  selectedByPid: boolean,
  ctype: string,
  env: NodeJS.ProcessEnv,
  deadline: number
): Promise<void> {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const now = monotonicNow()
  const missing: { row: LibprocProcessRow; key: string }[] = []
  for (const row of rows) {
    if (
      !row.commandIncomplete ||
      row.status === SZOMB_STATUS ||
      !(selectedByPid || descendsFromUsersTerminal(row, byPid))
    ) {
      continue
    }
    const key = commandKey(ctype, row)
    const cached = authoritativeCommands.get(key)
    if (cached && now - cached.cachedAtMs < AUTHORITATIVE_COMMAND_TTL_MS) {
      row.command = cached.command
    } else {
      missing.push({ row, key })
    }
  }
  const timeoutMs = Math.floor(deadline - monotonicNow())
  if (missing.length === 0 || timeoutMs <= 0) {
    return
  }
  let stdout: string
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-ww', '-o', 'pid=,command=', '-p', missing.map(({ row }) => row.pid).join(',')],
      env,
      timeoutMs,
      maxOutputBytes: 1024 * 1024
    })
    // Unreadable rows keep the executable path and retry next read.
    if (result.timedOut || result.outputTruncated || (result.code !== 0 && result.code !== 1)) {
      return
    }
    stdout = result.stdout
  } catch {
    return
  }
  const commands = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+) (.*)$/.exec(line)
    if (match) {
      commands.set(Number(match[1]), match[2])
    }
  }
  for (const { row, key } of missing) {
    const command = commands.get(row.pid)
    if (command !== undefined) {
      row.command = command
      rememberCommand(key, command, now)
    }
  }
}
