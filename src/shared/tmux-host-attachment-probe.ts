import { stat } from 'node:fs/promises'
import { readAgentProcess } from './agent-process-presence-probe'
import { runProcess } from './child-process/run-process'
import {
  PS_ARGS,
  parseStrictProcessTableRows,
  type ProcessTableRow
} from './process-table-snapshot'
import { parseTmuxAttachedClients, type TmuxAttachedClient } from './tmux-client-attachment'

const MAX_PROCESS_ROWS = 256

async function readSelectedRows(pids: readonly number[]): Promise<ProcessTableRow[]> {
  if (pids.length > 16) {
    const rows: ProcessTableRow[] = []
    for (let index = 0; index < pids.length; index += 16) {
      rows.push(...(await readSelectedRows(pids.slice(index, index + 16))))
    }
    return rows
  }
  if (pids.length > 1) {
    const rows = await Promise.all(pids.map((pid) => readSelectedRows([pid])))
    return rows.flat()
  }
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-p', pids.join(','), '-o', PS_ARGS[1]],
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
    timeoutMs: 1000,
    maxOutputBytes: 65536
  })
  if (result.timedOut || result.code !== 0 || result.stdout.length >= 65536) {
    throw new Error('tmux_process_capture_unverifiable')
  }
  const rows = parseStrictProcessTableRows(result.stdout)
  if (process.platform === 'linux') {
    return Promise.all(
      rows.map(async (row) => {
        const observed = await readAgentProcess(row.pid)
        return { ...row, startTime: observed.verdict === 'live' ? observed.startTime : undefined }
      })
    )
  }
  return rows
}

/** A bounded capture of tmux clients and their parent paths; never a whole-host scan. */
export async function probeTmuxHostAttachments(
  socket: string,
  rootPids: readonly number[]
): Promise<{ clients: TmuxAttachedClient[]; rows: ProcessTableRow[] } | null> {
  if (process.platform === 'win32' || rootPids.length === 0 || rootPids.length > 64) {
    return null
  }
  try {
    const socketStat = await stat(socket)
    if (!socketStat.isSocket() || (process.getuid && socketStat.uid !== process.getuid())) {
      return null
    }
    const result = await runProcess({
      program: 'tmux',
      args: ['-S', socket, 'list-clients', '-F', '#{client_pid}:#{pane_id}'],
      timeoutMs: 1000,
      maxOutputBytes: 65536
    })
    const clients =
      !result.timedOut && result.code === 0 ? parseTmuxAttachedClients(result.stdout) : null
    if (!clients) {
      return null
    }
    const byPid = new Map<number, ProcessTableRow>()
    let pids = [...new Set([...rootPids, ...clients.map((client) => client.pid)])]
    for (let depth = 0; depth < 8 && pids.length > 0; depth++) {
      if (byPid.size + pids.length > MAX_PROCESS_ROWS) {
        return null
      }
      for (const row of await readSelectedRows(pids)) {
        byPid.set(row.pid, row)
      }
      const missingParents = new Set<number>()
      for (const client of clients) {
        const visited = new Set<number>()
        let row = byPid.get(client.pid)
        while (row && !rootPids.includes(row.pid) && !visited.has(row.pid)) {
          visited.add(row.pid)
          if (row.ppid <= 1) {
            break
          }
          if (!byPid.has(row.ppid)) {
            missingParents.add(row.ppid)
            break
          }
          row = byPid.get(row.ppid)
        }
      }
      pids = [...missingParents]
    }
    return { clients, rows: [...byPid.values()] }
  } catch {
    return null
  }
}
