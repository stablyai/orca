import { useAppStore } from '@/store'
import { activateStructuredAgentSessionById } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { PipelineSessionBinding } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { RuntimeTerminalShow } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { PipelineWorkspace } from './use-pipeline-workspace'
import { callPipelineRpc } from './pipeline-api'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

export async function openPipelineSession(
  workspace: PipelineWorkspace,
  session: PipelineSessionBinding,
  runtimeId: string
) {
  let state = useAppStore.getState()
  if (
    selectWorkspaceByHostTarget(state, hostWorktreeTarget({ id: workspace.id, hostId: 'local' }))
      ?.instanceId !== workspace.instanceId
  ) {
    throw new Error('pipeline_workspace_instance_changed')
  }
  if (session.kind === 'structured') {
    if (
      !activateStructuredAgentSessionById({
        worktreeId: workspace.id,
        sessionId: session.sessionId,
        target: { kind: 'local' }
      })
    ) {
      throw new Error(
        'The saved session is no longer open. Reconcile its identity before continuing.'
      )
    }
    return
  }
  if (session.kind !== 'terminal' || !session.terminalHandle || !session.paneKey) {
    throw new Error('This stage has no agent session.')
  }
  const shown = await callPipelineRpc<{ terminal: RuntimeTerminalShow }>('terminal.show', {
    terminal: session.terminalHandle
  })
  state = useAppStore.getState()
  if (
    selectWorkspaceByHostTarget(state, hostWorktreeTarget({ id: workspace.id, hostId: 'local' }))
      ?.instanceId !== workspace.instanceId
  ) {
    throw new Error('pipeline_workspace_instance_changed')
  }
  if (
    shown.runtimeId !== runtimeId ||
    shown.terminal.worktreeId !== workspace.id ||
    !shown.terminal.connected ||
    !shown.terminal.writable ||
    !shown.terminal.ptyId ||
    !shown.terminal.tabId ||
    !shown.terminal.leafId ||
    makePaneKey(shown.terminal.tabId, shown.terminal.leafId) !== session.paneKey
  ) {
    throw new Error('The saved terminal identity is stale. No replacement was opened.')
  }
  if (
    state.terminalLayoutsByTabId[shown.terminal.tabId]?.ptyIdsByLeafId?.[shown.terminal.leafId] !==
    shown.terminal.ptyId
  ) {
    throw new Error('The saved terminal pane identity is stale. No replacement was opened.')
  }
  const tab = (state.unifiedTabsByWorktree[workspace.id] ?? []).find(
    (tab) => tab.contentType === 'terminal' && tab.entityId === shown.terminal.tabId
  )
  if (!tab) {
    throw new Error('The saved terminal tab is no longer open.')
  }
  state.focusGroup(workspace.id, tab.groupId)
  state.activateTab(tab.id, { worktreeId: workspace.id })
  state.setActiveTab(tab.entityId)
  state.setActiveTabType('terminal', workspace.id)
  focusTerminalTabSurface(tab.entityId, shown.terminal.leafId, {
    shouldFocus: () =>
      useAppStore.getState().terminalLayoutsByTabId[tab.entityId]?.ptyIdsByLeafId?.[
        shown.terminal.leafId!
      ] === shown.terminal.ptyId
  })
}
