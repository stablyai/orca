import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** PIDs a profile's daemons recorded under `<userData>/daemon`. */
export function readDaemonPidFiles(userDataDir: string): number[] {
  const daemonDir = path.join(userDataDir, 'daemon')
  if (!existsSync(daemonDir)) {
    return []
  }

  const pids: number[] = []
  for (const entry of readdirSync(daemonDir)) {
    if (!entry.endsWith('.pid')) {
      continue
    }
    let raw: string
    try {
      raw = readFileSync(path.join(daemonDir, entry), 'utf8').trim()
    } catch {
      // Why: an exiting daemon removes its pid file between readdir and read.
      continue
    }
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown }
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
        pids.push(parsed.pid)
      }
    } catch {
      const pid = Number(raw)
      if (Number.isInteger(pid)) {
        pids.push(pid)
      }
    }
  }
  return pids
}
