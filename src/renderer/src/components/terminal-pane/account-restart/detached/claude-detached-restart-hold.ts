import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { holdsClaudeRestartForTurn } from '../pane-account-restart-readiness'
import {
  skipsClaudeTurnHold,
  type QueuedClaudeRestart
} from '@/lib/agent-session/accounts/claude/claude-queued-restart-records'
import { warnDiscoveredClaudeNotMoved } from '../discovered-claude-restart'
import type { AppState } from '@/store/types'
import type { LocatedCodexPane } from './located-codex-pane'

const CLAUDE_RESTART_SPAWN_ATTEMPTS = 3

export function defersClaudeRestart(
  state: AppState,
  located: LocatedCodexPane,
  ptyId: string
): boolean {
  return (
    state.pendingPaneAccountRestarts[ptyId] === 'claude' &&
    located.leafId !== null &&
    holdsClaudeRestartForTurn(
      state,
      makePaneKey(located.tab.id, located.leafId),
      skipsClaudeTurnHold(ptyId)
    )
  )
}

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
