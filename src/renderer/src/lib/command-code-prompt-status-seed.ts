import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { resolveLiveAgentStatusConnectionRouting } from './agent-status-connection-ownership'
import { rendererAgentStatusObservations } from './renderer-agent-status-observations'

// Command Code lacks prompt-submit hooks; seed working when generated input is delivered so rows do not stay idle until its next hook.
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
      {
        state: 'working',
        prompt,
        agentType: 'command-code',
        observation: rendererAgentStatusObservations.observe(paneKey, {
          origin: 'process',
          observedAt: Date.now(),
          kind: 'transition'
        })
      },
      undefined,
      undefined,
      routing
    )
  } catch {
    // Best-effort UI seed. Real hooks still own refinement/completion.
  }
}
