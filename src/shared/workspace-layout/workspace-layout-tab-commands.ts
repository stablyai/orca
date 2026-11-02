import { filterRecord, omitStoredFields, withoutKey } from './stored-record-fields'
import { canReplacePreviewContentType, partitionPinnedTabOrder } from './tab-order'
import { getNextTerminalOrdinal } from './terminal-tab-ordinal'
import { layoutContainsLeafId } from './terminal-pane-tree'
import { editorTabShowsFile } from './workspace-layout-editor-tab-file'
import {
  applied,
  boundPtyIds,
  workspaceOrEmpty,
  findTab,
  findTerminal,
  leafIdsOf,
  placeNewTab,
  refuse,
  updateTab,
  type Applied,
  type TabPlacement
} from './workspace-layout-command-steps'
import type {
  CommandOf,
  LayoutCommandResult,
  LayoutContext
} from './workspace-layout-command-types'
import {
  paneKeyOf,
  type LayoutClosedTab,
  type LayoutContentTab,
  type LayoutTab,
  type LayoutTerminalTab,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'
import { admitsInitialSurface } from './workspace-layout-initial-surface'
import { removeTabFromWorkspace, withWorkspace } from './workspace-layout-removal'

type RefusedClose = NonNullable<LayoutCommandResult['refused']>[number]

export function createTerminalTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'createTerminalTab'>,
  context: LayoutContext
): Applied {
  if (command.initial && !admitsInitialSurface(model, command.workspace, command.initial)) {
    return applied(model)
  }
  const workspace = workspaceOrEmpty(model, command.workspace)
  const terminals = workspace.tabs.flatMap((tab) => (tab.kind === 'terminal' ? [tab] : []))
  const ordinal = getNextTerminalOrdinal(
    terminals.map((tab) => ({ defaultTitle: tab.terminal.defaultTitle, title: '' }))
  )
  const id = command.tabId ?? context.mintId()
  const leafId = command.leafId ?? context.mintLeafId()
  const tab: LayoutTerminalTab = {
    id,
    entityId: id,
    createdAt: command.createdAt ?? context.now(),
    customTitle: command.title ?? null,
    color: command.color ?? null,
    ...(command.quickCommandLabel ? { quickCommandLabel: command.quickCommandLabel } : {}),
    ...(command.viewMode ? { viewMode: command.viewMode } : {}),
    kind: 'terminal',
    terminal: { defaultTitle: `Terminal ${ordinal}`, ...command.creation },
    panes: { root: { type: 'leaf', leafId } }
  }
  const placed = placeNewTab(workspace, command.workspace, tab, command, context)
  const paneKey = paneKeyOf(id, leafId)
  return applied(
    withWorkspace(model, command.workspace, placed),
    { tabId: id, leafId, paneKey },
    { startPaneKeys: [paneKey] }
  )
}

/** Removes a tab and its content record; a terminal tab's pane data goes with it. */
export function closeTab(
  model: WorkspaceLayoutModel,
  key: string,
  tabId: string
): WorkspaceLayoutModel {
  const workspace = model.workspaces[key]!
  const tab = findTab(workspace, tabId)!
  let next: WorkspaceLayout = removeTabFromWorkspace(workspace, tabId)
  if (tab.kind === 'terminal' && next.leaves) {
    const leafIds = leafIdsOf(tab)
    next = { ...next, leaves: filterRecord(next.leaves, (leafId) => !leafIds.includes(leafId)) }
  }
  if (
    tab.kind === 'editor' &&
    next.editorFiles &&
    !next.tabs.some((entry) => entry.entityId === tab.entityId)
  ) {
    next = {
      ...next,
      editorFiles: next.editorFiles.filter(
        (file) => !editorTabShowsFile(tab.entityId, file, next.worktreeId)
      )
    }
  }
  if (next.editorViews) {
    next = { ...next, editorViews: withoutKey(next.editorViews, tabId) }
  }
  if (tab.kind === 'browser' && next.browserTabs) {
    next = { ...next, browserTabs: next.browserTabs.filter((entry) => entry.id !== tab.entityId) }
  }
  return withWorkspace(model, key, next)
}

export function closeTabs(
  model: WorkspaceLayoutModel,
  command: CommandOf<'closeTabs'>,
  context?: LayoutContext
): Applied {
  let next = model
  const closed: string[] = []
  const recorded: string[] = []
  const refused: RefusedClose[] = []
  const stopPtyIds: string[] = []
  for (const tabId of command.tabIds) {
    const tab = findTab(next.workspaces[command.workspace]!, tabId)
    if (!tab) {
      closed.push(tabId)
      recorded.push(tabId)
      continue
    }
    if (!command.force && command.refusePinned && tab.isPinned) {
      refused.push({ tabId, code: 'tab_pinned' })
      continue
    }
    if (!command.force && command.dirtyTabIds?.includes(tabId)) {
      refused.push({ tabId, code: 'editor_tab_has_unsaved_draft' })
      continue
    }
    stopPtyIds.push(...boundPtyIds(next.workspaces[command.workspace]!, tab))
    next = closeTab(next, command.workspace, tabId)
    closed.push(tabId)
    if (tab.kind === 'terminal') {
      recorded.push(tab.entityId)
    }
  }
  if (command.recordClose && context && recorded.length > 0) {
    next = recordClosedTerminalTabs(next, command.workspace, recorded, {
      reason: command.recordClose,
      closedAt: context.now()
    })
  }
  return applied(next, { closed, refused }, { stopPtyIds })
}

function recordClosedTerminalTabs(
  model: WorkspaceLayoutModel,
  key: string,
  tabIds: readonly string[],
  record: LayoutClosedTab
): WorkspaceLayoutModel {
  const workspace = model.workspaces[key]!
  const closedTerminalTabs = { ...workspace.closedTerminalTabs }
  for (const tabId of tabIds) {
    closedTerminalTabs[tabId] = record
  }
  return withWorkspace(model, key, { ...workspace, closedTerminalTabs })
}

export function renameTab(model: WorkspaceLayoutModel, command: CommandOf<'renameTab'>): Applied {
  const tab = findTab(model.workspaces[command.workspace]!, command.tabId)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (command.kind === 'aiVault') {
    return updateTab(model, command.workspace, { ...tab, aiVaultTitle: command.title })
  }
  return updateTab(
    model,
    command.workspace,
    command.kind === 'custom'
      ? { ...tab, customTitle: command.title }
      : { ...tab, generatedTitle: command.title }
  )
}

export function setTabProps(
  model: WorkspaceLayoutModel,
  command: CommandOf<'setTabProps'>
): Applied {
  const workspace = model.workspaces[command.workspace]!
  const tab = findTab(workspace, command.tabId)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (command.clearLaunchAgent && tab.kind !== 'terminal') {
    return refuse('invalid_params')
  }
  const props = {
    ...(command.color !== undefined ? { color: command.color } : {}),
    ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
    ...(command.viewMode !== undefined ? { viewMode: command.viewMode } : {})
  }
  const next: LayoutTab =
    command.clearLaunchAgent && tab.kind === 'terminal'
      ? { ...tab, ...props, terminal: omitStoredFields(tab.terminal, ['launchAgent']) }
      : { ...tab, ...props }
  let updated = {
    ...workspace,
    tabs: workspace.tabs.map((entry) => (entry.id === tab.id ? next : entry))
  }
  if (command.isPinned !== undefined && command.isPinned !== (tab.isPinned === true)) {
    // Pinning moves the tab to the edge of the pinned run, as the tab bar does.
    updated = {
      ...updated,
      groups: updated.groups.map((group) =>
        group.tabOrder.includes(tab.id)
          ? { ...group, tabOrder: partitionPinnedTabOrder(group.tabOrder, updated.tabs, tab.id) }
          : group
      )
    }
  }
  return applied(withWorkspace(model, command.workspace, updated))
}

export function setChatPane(
  model: WorkspaceLayoutModel,
  command: CommandOf<'setChatPane'>
): Applied {
  const tab = findTerminal(model.workspaces[command.workspace]!, command.tabId)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (command.leafId !== null && !layoutContainsLeafId(tab.panes.root, command.leafId)) {
    return refuse('pane_not_found')
  }
  const panes = omitStoredFields(tab.panes, ['chatLeafId'])
  return updateTab(model, command.workspace, {
    ...tab,
    panes: command.leafId === null ? panes : { ...panes, chatLeafId: command.leafId }
  })
}

export function promotePreviewTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'promotePreviewTab'>
): Applied {
  const tab = findTab(model.workspaces[command.workspace]!, command.tabId)
  if (!tab) {
    return refuse('tab_not_found')
  }
  const promoted = { ...tab }
  delete promoted.isPreview
  return updateTab(model, command.workspace, promoted)
}

/**
 * A new tab replaces the group's preview tab of a compatible kind, as a single click does today,
 * unless closing it is refused like any close (an unsaved draft): then both stay. The new tab is
 * placed first, so closing a group's only tab, its preview, never closes the group.
 */
export function placeContentTab(
  model: WorkspaceLayoutModel,
  key: string,
  tab: LayoutContentTab,
  placement: TabPlacement & { dirtyTabIds?: string[] },
  context: LayoutContext
): { model: WorkspaceLayoutModel; refused: RefusedClose[] } {
  const workspace = workspaceOrEmpty(model, key)
  const anchor = placement.afterTabId
  // A named group this copy lacks falls back to the anchor's.
  const group =
    workspace.groups.find((entry) => entry.id === placement.groupId) ??
    (anchor ? workspace.groups.find((entry) => entry.tabOrder.includes(anchor)) : undefined) ??
    workspace.groups[0]
  const preview = tab.isPreview
    ? workspace.tabs.find(
        (entry) =>
          entry.isPreview &&
          group?.tabOrder.includes(entry.id) &&
          canReplacePreviewContentType(tab.kind, entry.kind)
      )
    : undefined
  const placed = withWorkspace(
    model,
    key,
    placeNewTab(
      workspace,
      key,
      tab,
      // The sender's group names a workspace's first group.
      {
        groupId: group?.id ?? placement.groupId,
        afterTabId: placement.afterTabId,
        index: placement.index
      },
      context
    )
  )
  if (!preview) {
    return { model: placed, refused: [] }
  }
  const closing = closeTabs(placed, {
    type: 'closeTabs',
    workspace: key,
    tabIds: [preview.id],
    dirtyTabIds: placement.dirtyTabIds
  })
  return closing.ok
    ? { model: closing.model, refused: closing.result.refused ?? [] }
    : { model: placed, refused: [] }
}
