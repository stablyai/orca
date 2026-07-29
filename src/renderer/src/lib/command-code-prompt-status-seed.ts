import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { resolveLiveAgentStatusConnectionRouting } from './agent-status-connection-ownership'

/**
 * Why: Command Code has no prompt-submit hook, so when Orca submits a generated
 * prompt after the TUI is ready, seed `working` at delivery time so sidebar and
 * activity surfaces don't stay idle until the first real hook event arrives.
 */
export function seedCommandCodeSubmittedPromptStatus(
  worktreeId: string,
  tabId: string,
  prompt: string
): void {
  const state = useAppStore.getState()
  const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
  if (!leafId || !(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)) {
    return
  }
  const paneKey = makePaneKey(tabId, leafId)
  const ptyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  if (!ptyId) {
    return
  }
  const routing = resolveLiveAgentStatusConnectionRouting({
    state,
    paneKey,
    ptyId,
    expectedConnectionId: getConnectionIdFromState(state, worktreeId)
  })
  if (!routing) {
    return
  }
  try {
    state.setAgentStatus(
      paneKey,
      { state: 'working', prompt, agentType: 'command-code' },
      undefined,
      undefined,
      routing
    )
  } catch {
    // Best-effort UI seed. Real hooks still own refinement/completion.
  }
}
