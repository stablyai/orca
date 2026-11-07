import { useAppStore } from '@/store'
import { workspaceHasSleepingAgentSessions } from '@/lib/workspace/activation/worktree-agent-activation-gate'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/agent-session/resume/resume-sleeping-agent-session'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { gateAndReseedEmptyWorkspace } from './workspace/activation/worktree-activation-gated-empty-reseed'
import type { GatedEmptyWorkspaceReseedIntent } from './workspace/activation/initial-surface/worktree-initial-terminal-seeding'

const canInspectAgentActivationInventory = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.api?.runtime?.call === 'function' &&
  typeof window.api?.pty?.listSessions === 'function'

/** Wake a workspace's sleeping agents; true when the inventory gate, not this call, decides. */
export function wakeWorkspaceAgents(
  workspaceKey: string,
  intent: GatedEmptyWorkspaceReseedIntent & { hasActivationWork: boolean }
): boolean {
  const state = useAppStore.getState()
  // Decide gate before resuming: resume consumes sleeping evidence, and late structured inventory can otherwise authorize a shell beside a pending chat (STA-1111).
  const gated =
    !intent.hasActivationWork &&
    (workspaceHasSleepingAgentSessions(state, workspaceKey) ||
      (canInspectAgentActivationInventory() &&
        shouldAutoCreateInitialTerminal(
          state.reconcileWorktreeTabModel(workspaceKey).renderableTabCount
        )))
  if (gated) {
    gateAndReseedEmptyWorkspace(workspaceKey, {
      callerProvidesSurface: intent.callerProvidesSurface,
      seedUserDefaultSurface: intent.seedUserDefaultSurface,
      ...(intent.initialCwd ? { initialCwd: intent.initialCwd } : {}),
      ...(intent.executionHostId ? { executionHostId: intent.executionHostId } : {})
    })
  } else {
    // Resume preserved provider sessions before shell seeding; synchronous tab creation prevents an extra bare shell.
    resumeSleepingAgentSessionsForWorktree(workspaceKey)
  }
  return gated
}
