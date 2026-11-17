import type { QueuedClaudeRestart } from '@/lib/agent-session/accounts/claude/claude-queued-restart-records'
import { warnDiscoveredClaudeNotMoved } from '../discovered-claude-restart'

const CLAUDE_RESTART_SPAWN_ATTEMPTS = 3

export function retryableClaudeSpawn<T>(
  spawning: Promise<T>,
  rejectedSpawns: number,
  queued: QueuedClaudeRestart | undefined
): Promise<T | null> {
  return spawning.catch((err: unknown) => {
    const retries =
      rejectedSpawns + 1 < CLAUDE_RESTART_SPAWN_ATTEMPTS && queued?.restartAll === true
    if (retries) {
      return null
    }
    if (queued?.session) {
      warnDiscoveredClaudeNotMoved()
    }
    throw err
  })
}
