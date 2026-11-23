import { execFileSync } from 'node:child_process'
import path from 'node:path'

function ownsCrashpad(command: string, userDataDir: string): boolean {
  return (
    command.includes('/chrome_crashpad_handler ') &&
    command.includes(` --database=${path.join(userDataDir, 'Crashpad')} `)
  )
}

export function cleanupE2ECrashpad(userDataDir: string): void {
  if (process.platform !== 'darwin') {
    return
  }

  // macOS reparents Crashpad before app exit; its inherited stderr can keep Playwright open.
  try {
    const table = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 5_000
    })
    for (const row of table.split('\n')) {
      const match = row.match(/^\s*(\d+)\s+(.+)$/)
      if (!match || !ownsCrashpad(match[2], userDataDir)) {
        continue
      }
      const pid = Number(match[1])
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        continue
      }
      try {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
          encoding: 'utf8',
          timeout: 5_000
        })
        if (ownsCrashpad(command, userDataDir)) {
          process.kill(pid, 'SIGTERM')
        }
      } catch {
        // The test-owned reporter may already have exited.
      }
    }
  } catch {
    // Cleanup remains best-effort when process enumeration is unavailable.
  }
}
