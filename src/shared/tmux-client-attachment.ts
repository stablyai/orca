import type { ProcessTableRow } from './process-table-snapshot'

export type TmuxHookPane = { socket: string; pane: string }
export type TmuxAttachedClient = { pid: number; pane: string }

export function readTmuxHookPane(value: unknown): TmuxHookPane | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  if (!('socket' in value) || !('pane' in value)) {
    return null
  }
  const { socket, pane } = value
  if (
    typeof socket !== 'string' ||
    !socket.startsWith('/') ||
    socket.length > 1024 ||
    /[\0\r\n]/.test(socket) ||
    typeof pane !== 'string' ||
    !/^%\d{1,12}$/.test(pane)
  ) {
    return null
  }
  return { socket, pane }
}

export function parseTmuxAttachedClients(output: string): TmuxAttachedClient[] | null {
  if (output.length > 65536) {
    return null
  }
  const clients: TmuxAttachedClient[] = []
  for (const line of output.trim().split('\n')) {
    if (!line) {
      continue
    }
    const match = /^(\d+):(%\d{1,12})$/.exec(line)
    const pid = Number(match?.[1])
    if (!match || !Number.isSafeInteger(pid) || pid <= 0 || clients.length >= 128) {
      return null
    }
    clients.push({ pid, pane: match[2] })
  }
  return clients
}

/** Only this outer terminal's foreground client selects its projected inner pane. */
export function resolveTmuxClientAttachment(
  rootPid: number,
  clients: readonly TmuxAttachedClient[],
  rows: readonly ProcessTableRow[]
): TmuxAttachedClient | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const root = byPid.get(rootPid)
  if (!root?.startTime || !root.tty || root.tty === '?' || !root.tpgid || root.tpgid <= 0) {
    return null
  }
  const attached = clients.filter((client) => {
    const row = byPid.get(client.pid)
    if (
      !row?.startTime ||
      row.tty !== root.tty ||
      row.pgid !== root.tpgid ||
      !/^(?:\S*\/)?tmux(?:\s|$)/.test(row.command) ||
      /[ZT]/.test(row.stat)
    ) {
      return false
    }
    const visited = new Set<number>()
    let current: ProcessTableRow | undefined = row
    while (current && visited.size < 32 && !visited.has(current.pid)) {
      if (current.pid === rootPid) {
        return true
      }
      visited.add(current.pid)
      current = byPid.get(current.ppid)
    }
    return false
  })
  return attached.length === 1 ? attached[0] : null
}
