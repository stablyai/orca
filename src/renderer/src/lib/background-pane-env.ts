import { getWorktreeServiceEnv } from '@/lib/worktree-service-env-injection'
import { makePaneKey } from '../../../shared/stable-pane-id'

// Why: background tabs never mount a TerminalPane, so the pane-identity env
// (and the worktree's isolated-service env) must be injected at spawn time.
// Shared by the background terminal and background agent-session launchers.
export function buildBackgroundPaneEnv(
  worktreeId: string,
  tabId: string,
  leafId: string,
  env: Record<string, string> | undefined
): Record<string, string> {
  return {
    ...env,
    ...getWorktreeServiceEnv(worktreeId),
    ORCA_PANE_KEY: makePaneKey(tabId, leafId),
    ORCA_TAB_ID: tabId,
    ORCA_WORKTREE_ID: worktreeId
  }
}
