import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceAttachmentOrigin } from '../../../shared/worktree/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { terminalLayoutContainsLeaf } from '../../../shared/workspace-session-pane-ownership'

export type WorkspaceReferenceTerminalContext = {
  tabId: string
  paneKey: string
  ptyId?: string | null
  executionHostId?: ExecutionHostId
}

export function getWorkspaceAttachmentTerminalOrigin(
  state: Pick<AppState, 'tabsByWorktree' | 'agentStatusByPaneKey' | 'terminalLayoutsByTabId'>,
  worktreeId: string,
  context: WorkspaceReferenceTerminalContext,
  hostId: ExecutionHostId | undefined
): WorkspaceAttachmentOrigin | undefined {
  const tab = state.tabsByWorktree?.[worktreeId]?.find(
    (candidate) => candidate.id === context.tabId
  )
  const pane = parsePaneKey(context.paneKey)
  const layout = state.terminalLayoutsByTabId?.[context.tabId]
  if (!tab || !pane || pane.tabId !== tab.id || !layout) {
    return undefined
  }
  if (!terminalLayoutContainsLeaf(layout.root, pane.leafId)) {
    return undefined
  }
  const ptyId =
    layout.ptyIdsByLeafId?.[pane.leafId] ?? (layout.root?.type === 'leaf' ? tab.ptyId : null)
  if (!context.ptyId || context.ptyId !== ptyId) {
    return undefined
  }
  const entry = state.agentStatusByPaneKey?.[context.paneKey]
  const matchingEntry =
    (entry?.worktreeId && entry.worktreeId !== worktreeId) ||
    (entry?.terminalHandle && entry.terminalHandle !== ptyId)
      ? undefined
      : entry
  return {
    kind: 'observed',
    tabId: tab.id,
    paneKey: context.paneKey,
    ...(hostId ? { hostId } : {}),
    label: tab.customTitle || tab.defaultTitle || tab.title,
    ...(matchingEntry?.agentType ? { agent: matchingEntry.agentType } : {}),
    ...(matchingEntry?.providerSession?.id ? { sessionId: matchingEntry.providerSession.id } : {})
  }
}
