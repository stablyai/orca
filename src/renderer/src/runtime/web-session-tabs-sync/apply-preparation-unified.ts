import type { prepareWebSessionTabsSnapshotBrowser } from './apply-preparation-browser'
import { buildTerminalUnifiedTab } from './tab-builders'
import { isAgentSessionTab } from './terminal-surfaces'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import {
  resolveWebSessionSiblingVisibleTabId,
  resolveWebSessionVisibleTabId
} from '../web-session-focus-intent'
import { isWebSessionBrowserPlacementGroupReserved } from '../web-session-browser-placement'
import { buildHostToLocalTabIdMap, updateHostSessionTabIdMappings } from './layout-groups'

export function prepareWebSessionTabsSnapshotUnified(
  base: ReturnType<typeof prepareWebSessionTabsSnapshotBrowser>
) {
  const {
    state,
    snapshot,
    environmentId,
    worktreeId,
    navigationIntentTab,
    honorSnapshotActiveFocus,
    terminalSurfaceTabs,
    mirroredTerminalTabs,
    mirroredTerminalTabEntries,
    nextTerminalTabs,
    mirroredBrowserTabs,
    mirroredEditorTabs,
    mirroredAgentTabs,
    readyBrowserTabs,
    readyEditorTabs,
    nextBrowserTabs,
    nextWorktreeOpenFileIds,
    retainedUnifiedTabs,
    existingViewModeByTabId,
    hostGroupIdByTabId,
    targetGroupId
  } = base
  const mirroredTerminalUnifiedTabs = mirroredTerminalTabs.map((entry) =>
    buildTerminalUnifiedTab(
      entry.tab,
      entry.containerId,
      hostGroupIdByTabId.get(entry.hostTabId) ?? targetGroupId,
      environmentId,
      entry.tab.viewMode ?? existingViewModeByTabId.get(entry.containerId),
      entry.origin
    )
  )
  const mirroredBrowserUnifiedTabs = mirroredBrowserTabs.map((entry) => entry.unifiedTab)
  const mirroredEditorUnifiedTabs = mirroredEditorTabs.map((entry) => entry.unifiedTab)
  const mirroredAgentUnifiedTabs = mirroredAgentTabs.map((entry) => entry.unifiedTab)
  const mirroredUnifiedTabs = [
    ...mirroredTerminalUnifiedTabs,
    ...mirroredBrowserUnifiedTabs,
    ...mirroredEditorUnifiedTabs,
    ...mirroredAgentUnifiedTabs
  ]
  const mirroredUnifiedIds = new Set(mirroredUnifiedTabs.map((tab) => tab.id))
  // A tab a host switch refilled is rebuilt with its new content, never kept beside it.
  const retainedOutsideMirror = retainedUnifiedTabs.filter((tab) => !mirroredUnifiedIds.has(tab.id))
  const nextUnifiedTabs =
    retainedOutsideMirror.length + mirroredUnifiedTabs.length > 0
      ? [...retainedOutsideMirror, ...mirroredUnifiedTabs]
      : null
  // The tab holding a terminal: its own id unless a host switch put it in a tab with another.
  const containerIdByTerminalId = new Map(
    mirroredTerminalTabs.map((entry) => [entry.tab.id, entry.containerId])
  )
  const containerOfTerminal = (terminalTabId: string | null): string | null =>
    terminalTabId === null ? null : (containerIdByTerminalId.get(terminalTabId) ?? terminalTabId)
  const validUnifiedTabIds = new Set(nextUnifiedTabs?.map((tab) => tab.id) ?? [])
  const activeHostTerminalId =
    terminalSurfaceTabs.find((tab) => tab.id === snapshot.activeTabId)?.id ??
    terminalSurfaceTabs.find((tab) => tab.isActive)?.id ??
    null
  const activeHostTerminalParentId =
    terminalSurfaceTabs.find((tab) => tab.id === activeHostTerminalId)?.parentTabId ??
    terminalSurfaceTabs.find((tab) => tab.isActive)?.parentTabId ??
    null
  const activeMirroredTerminalId = activeHostTerminalId
    ? toWebTerminalSurfaceTabId(activeHostTerminalParentId ?? activeHostTerminalId)
    : null
  const activeHostBrowser =
    readyBrowserTabs.find((tab) => tab.id === snapshot.activeTabId) ??
    readyBrowserTabs.find((tab) => tab.isActive) ??
    null
  const activeMirroredBrowser = activeHostBrowser
    ? (mirroredBrowserTabs.find(
        (entry) => entry.remotePageId === activeHostBrowser.browserPageId
      ) ?? null)
    : null
  const activeMirroredBrowserTabId = activeMirroredBrowser?.unifiedTab.id ?? null
  const activeMirroredBrowserWorkspaceId = activeMirroredBrowser?.workspace.id ?? null
  const activeHostEditor =
    readyEditorTabs.find((tab) => tab.id === snapshot.activeTabId) ??
    readyEditorTabs.find((tab) => tab.isActive) ??
    null
  const activeMirroredEditor = activeHostEditor
    ? (mirroredEditorTabs.find((entry) => entry.hostTabId === activeHostEditor.id) ?? null)
    : null
  const activeMirroredEditorFileId = activeMirroredEditor?.file.id ?? null
  const activeMirroredEditorTabId = activeMirroredEditor?.unifiedTab.id ?? null
  const activeHostAgent =
    snapshot.tabs
      .filter(isAgentSessionTab)
      .find((tab) => tab.id === snapshot.activeTabId || tab.isActive) ?? null
  const activeMirroredAgentTabId = activeHostAgent
    ? (mirroredAgentTabs.find((entry) => entry.hostTabId === activeHostAgent.id)?.unifiedTab.id ??
      null)
    : null
  const intentMirroredTerminalId =
    navigationIntentTab?.type === 'terminal'
      ? toWebTerminalSurfaceTabId(navigationIntentTab.parentTabId)
      : null
  const intentMirroredBrowser =
    navigationIntentTab?.type === 'browser'
      ? (mirroredBrowserTabs.find(
          (entry) =>
            entry.hostTabId === navigationIntentTab.id ||
            entry.remotePageId === navigationIntentTab.browserPageId
        ) ?? null)
      : null
  const intentMirroredEditor =
    navigationIntentTab?.type === 'markdown' || navigationIntentTab?.type === 'file'
      ? (mirroredEditorTabs.find((entry) => entry.hostTabId === navigationIntentTab.id) ?? null)
      : null
  const intentMirroredAgent =
    navigationIntentTab?.type === 'agent-session'
      ? (mirroredAgentTabs.find((entry) => entry.hostTabId === navigationIntentTab.id) ?? null)
      : null
  const currentActiveTerminalStillExists =
    state.activeTabIdByWorktree[worktreeId] &&
    (nextTerminalTabs ?? []).some((tab) => tab.id === state.activeTabIdByWorktree[worktreeId])
      ? state.activeTabIdByWorktree[worktreeId]
      : null
  // Why: caller intent targets the requested tab even when an older host leaves its own active tab unchanged.
  const intentTerminalId =
    honorSnapshotActiveFocus && navigationIntentTab?.type === 'terminal'
      ? intentMirroredTerminalId
      : null
  const nextActiveTerminalId =
    intentTerminalId ??
    currentActiveTerminalStillExists ??
    (snapshot.activeTabType === 'terminal'
      ? (activeMirroredTerminalId ?? mirroredTerminalTabEntries[0]?.id)
      : mirroredTerminalTabEntries[0]?.id) ??
    // Another runtime's terminals can outlive this frame's own (#31983).
    nextTerminalTabs?.[0]?.id ??
    null
  const currentActiveBrowserStillExists =
    state.activeBrowserTabIdByWorktree[worktreeId] &&
    (nextBrowserTabs ?? []).some((tab) => tab.id === state.activeBrowserTabIdByWorktree[worktreeId])
      ? state.activeBrowserTabIdByWorktree[worktreeId]
      : null
  const intentBrowserWorkspaceId =
    honorSnapshotActiveFocus && navigationIntentTab?.type === 'browser'
      ? (intentMirroredBrowser?.workspace.id ?? null)
      : null
  const nextActiveBrowserWorkspaceId =
    intentBrowserWorkspaceId ??
    currentActiveBrowserStillExists ??
    (snapshot.activeTabType === 'browser'
      ? (activeMirroredBrowserWorkspaceId ?? mirroredBrowserTabs[0]?.workspace.id)
      : mirroredBrowserTabs[0]?.workspace.id) ??
    null
  const activeEditorFileIdForWorktree = state.activeFileIdByWorktree[worktreeId]
  const currentActiveEditorStillExists =
    activeEditorFileIdForWorktree && nextWorktreeOpenFileIds.has(activeEditorFileIdForWorktree)
      ? activeEditorFileIdForWorktree
      : null
  const intentEditorFileId = honorSnapshotActiveFocus
    ? (intentMirroredEditor?.file.id ?? null)
    : null
  const nextActiveEditorFileId =
    intentEditorFileId ??
    currentActiveEditorStillExists ??
    (snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
      ? (activeMirroredEditorFileId ?? mirroredEditorTabs[0]?.file.id)
      : mirroredEditorTabs[0]?.file.id) ??
    null
  const currentVisibleUnifiedTabId = resolveWebSessionVisibleTabId(
    state,
    worktreeId,
    nextUnifiedTabs ?? []
  )
  const currentVisibleStructuredTabId =
    currentVisibleUnifiedTabId &&
    nextUnifiedTabs?.find(
      (tab) => tab.id === currentVisibleUnifiedTabId && tab.contentType === 'agent-session'
    )
      ? currentVisibleUnifiedTabId
      : null
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  // Reserved preview splits can be active before browser arrival; emptiness must not become terminal focus intent.
  const reservedEmptyPreviewFallbackTabId =
    currentVisibleUnifiedTabId == null &&
    activeGroupId != null &&
    isWebSessionBrowserPlacementGroupReserved({ worktreeId, groupId: activeGroupId })
      ? resolveWebSessionSiblingVisibleTabId(state, worktreeId, nextUnifiedTabs ?? [])
      : null
  // Why: a client-initiated activation also drives the visible unified tab, overriding the sticky current-visible tab.
  const intentUnifiedTabId = honorSnapshotActiveFocus
    ? navigationIntentTab?.type === 'browser'
      ? (intentMirroredBrowser?.unifiedTab.id ?? null)
      : navigationIntentTab?.type === 'terminal'
        ? containerOfTerminal(intentTerminalId)
        : navigationIntentTab?.type === 'agent-session'
          ? (intentMirroredAgent?.unifiedTab.id ?? null)
          : navigationIntentTab?.type === 'markdown' || navigationIntentTab?.type === 'file'
            ? (intentMirroredEditor?.unifiedTab.id ?? null)
            : null
    : null
  const nextActiveUnifiedTabId =
    intentUnifiedTabId ??
    currentVisibleUnifiedTabId ??
    reservedEmptyPreviewFallbackTabId ??
    (snapshot.activeTabType === 'agent-session'
      ? (activeMirroredAgentTabId ??
        mirroredAgentUnifiedTabs[0]?.id ??
        containerOfTerminal(nextActiveTerminalId))
      : snapshot.activeTabType === 'browser'
        ? (activeMirroredBrowserTabId ??
          mirroredBrowserTabs[0]?.unifiedTab.id ??
          containerOfTerminal(state.activeTabIdByWorktree[worktreeId] ?? nextActiveTerminalId))
        : snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
          ? (activeMirroredEditorTabId ??
            mirroredEditorTabs[0]?.unifiedTab.id ??
            containerOfTerminal(state.activeTabIdByWorktree[worktreeId] ?? nextActiveTerminalId))
          : containerOfTerminal(nextActiveTerminalId))
  const hostToLocalTabId = buildHostToLocalTabIdMap({
    terminalSurfaces: terminalSurfaceTabs,
    terminalTabs: mirroredTerminalTabs,
    browserTabs: mirroredBrowserTabs,
    editorTabs: mirroredEditorTabs,
    agentTabs: mirroredAgentTabs
  })
  updateHostSessionTabIdMappings({
    environmentId,
    worktreeId,
    terminalTabs: mirroredTerminalTabs,
    browserTabs: mirroredBrowserTabs,
    editorTabs: mirroredEditorTabs,
    agentTabs: mirroredAgentTabs,
    hostGroupIdByTabId
  })

  return {
    ...base,
    mirroredTerminalUnifiedTabs,
    mirroredBrowserUnifiedTabs,
    mirroredEditorUnifiedTabs,
    mirroredAgentUnifiedTabs,
    mirroredUnifiedTabs,
    nextUnifiedTabs,
    validUnifiedTabIds,
    activeHostTerminalId,
    activeMirroredTerminalId,
    activeHostBrowser,
    activeMirroredBrowser,
    activeMirroredBrowserTabId,
    activeMirroredBrowserWorkspaceId,
    activeHostEditor,
    activeMirroredEditor,
    activeMirroredEditorFileId,
    activeMirroredEditorTabId,
    activeHostAgent,
    activeMirroredAgentTabId,
    intentMirroredTerminalId,
    intentMirroredBrowser,
    intentMirroredEditor,
    intentMirroredAgent,
    currentActiveTerminalStillExists,
    intentTerminalId,
    nextActiveTerminalId,
    currentActiveBrowserStillExists,
    intentBrowserWorkspaceId,
    nextActiveBrowserWorkspaceId,
    currentActiveEditorStillExists,
    intentEditorFileId,
    nextActiveEditorFileId,
    currentVisibleUnifiedTabId,
    currentVisibleStructuredTabId,
    reservedEmptyPreviewFallbackTabId,
    intentUnifiedTabId,
    nextActiveUnifiedTabId,
    mirroredUnifiedIds,
    hostToLocalTabId
  }
}
