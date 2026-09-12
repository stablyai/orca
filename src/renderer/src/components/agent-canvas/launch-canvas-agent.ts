import { useAppStore } from '@/store'
import { getActiveExecutionHostIdForWorktree } from '@/lib/unified-tab-host-ownership'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { resolveWorktreeOperationRouteResultForHost } from '@/lib/worktree-operation-route'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/web-runtime-terminal-create-operation'
import { toWebTerminalSurfaceTabId } from '@/runtime/web-terminal-surface-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

export async function launchCanvasAgent(tab: Tab, agent: TuiAgent): Promise<string> {
  const state = useAppStore.getState()
  if (
    !tab.executionHostId ||
    getActiveExecutionHostIdForWorktree(state, tab.worktreeId) !== tab.executionHostId
  ) {
    throw new Error('Select this canvas workspace before starting an agent.')
  }
  const resolution = resolveWorktreeOperationRouteResultForHost(
    state,
    tab.worktreeId,
    tab.executionHostId
  )
  if (resolution.kind !== 'resolved') {
    throw new Error('The workspace host is unavailable.')
  }
  const environmentId = resolution.route.runtimeEnvironmentId
  if (environmentId) {
    const result = await createWebRuntimeSessionTerminalResult({
      worktreeId: tab.worktreeId,
      environmentId,
      targetGroupId: tab.groupId,
      agent,
      viewMode: 'terminal',
      activate: false,
      selectWorktree: false
    })
    if (result.outcome.status !== 'created' || !result.hostTabId) {
      throw new Error(
        result.outcome.status === 'failed'
          ? result.outcome.message
          : 'The host has not confirmed the new terminal identity. Check the workspace before retrying.'
      )
    }
    return toWebTerminalSurfaceTabId(result.hostTabId)
  }
  const result = launchAgentInNewTab({
    agent,
    worktreeId: tab.worktreeId,
    groupId: tab.groupId,
    viewMode: 'terminal'
  })
  state.activateTab(tab.id)
  state.focusGroup(tab.worktreeId, tab.groupId)
  state.setActiveTabType('canvas')
  if (!result?.tabId) {
    throw new Error('The agent could not be started. Check its configuration in Settings.')
  }
  return result.tabId
}
