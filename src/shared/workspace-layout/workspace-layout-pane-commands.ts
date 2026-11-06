// Pane IDs and their keyed data/scrollback survive moves.

import { getNextTerminalOrdinal } from './terminal-tab-ordinal'
import {
  equalizeLayout,
  insertLeafBeside,
  layoutContainsLeafId,
  removeLayoutLeaf,
  samePanesIgnoringRatios
} from './terminal-pane-tree'
import {
  applied,
  findTerminal,
  leafIdsOf,
  placeNewTab,
  refuse,
  setLeaf,
  updateTab,
  type Applied
} from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext, WindowPaneDetach } from './workspace-layout-command-types'
import {
  paneKeyOf,
  type LayoutTerminalTab,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'
import { retireTerminalPane, withWorkspace } from './workspace-layout-removal'
import { withPaneSplitRatios } from './split-ratio-intents'

type PaneCommand = { workspace: string; tabId: string }

function paneTab(model: WorkspaceLayoutModel, command: PaneCommand): LayoutTerminalTab | null {
  const tab = findTerminal(model.workspaces[command.workspace]!, command.tabId)
  return tab?.panes.root ? tab : null
}

export function splitPane(
  model: WorkspaceLayoutModel,
  command: CommandOf<'splitPane'>,
  context: LayoutContext
): Applied {
  const tab = paneTab(model, command)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (!layoutContainsLeafId(tab.panes.root, command.leafId)) {
    return refuse('pane_not_found')
  }
  const leafId = command.newLeafId ?? context.mintLeafId()
  const side = command.direction === 'vertical' ? 'right' : 'bottom'
  const root = insertLeafBeside(tab.panes.root!, command.leafId, leafId, side, command.ratio)
  const next = updateTab(model, command.workspace, { ...tab, panes: { ...tab.panes, root } })
  if (!next.ok) {
    return next
  }
  const paneKey = paneKeyOf(tab.entityId, leafId)
  return applied(next.model, { leafId, paneKey }, { startPaneKeys: [paneKey] })
}

/** Closing a pane that is already gone succeeds; the last pane closes its tab. */
export function closePane(model: WorkspaceLayoutModel, command: CommandOf<'closePane'>): Applied {
  const tab = findTerminal(model.workspaces[command.workspace]!, command.tabId)
  if (!tab || !layoutContainsLeafId(tab.panes.root, command.leafId)) {
    return applied(model, { alreadyClosed: true })
  }
  const leaf = model.workspaces[command.workspace]!.leaves?.[command.leafId]
  if (command.userPaneClose && tab.panes.root?.type === 'leaf') {
    return refuse('last_pane')
  }
  const ptyId = leaf?.ptyId
  const retired = retireTerminalPane(
    model,
    { workspaceKey: command.workspace, tab },
    command.leafId
  )
  const tabClosed = !retired.workspaces[command.workspace]!.tabs.some(
    (entry) => entry.id === tab.id
  )
  return applied(retired, { tabClosed }, { stopPtyIds: ptyId ? [ptyId] : [] })
}

export function movePane(model: WorkspaceLayoutModel, command: CommandOf<'movePane'>): Applied {
  if (command.leafId === command.targetLeafId) {
    return refuse('same_pane')
  }
  const tab = paneTab(model, command)
  if (!tab) {
    return refuse('tab_not_found')
  }
  const { root } = tab.panes
  if (
    !layoutContainsLeafId(root, command.leafId) ||
    !layoutContainsLeafId(root, command.targetLeafId)
  ) {
    return refuse('pane_not_found')
  }
  const without = removeLayoutLeaf(root, command.leafId)!
  const moved = insertLeafBeside(without, command.targetLeafId, command.leafId, command.side)
  return updateTab(model, command.workspace, { ...tab, panes: { ...tab.panes, root: moved } })
}

/** Accept divider ratios only when the tree and panes still match (rule 11). */
export function setPaneRatios(
  model: WorkspaceLayoutModel,
  command: CommandOf<'setPaneRatios'>
): Applied {
  const tab = paneTab(model, command)
  if (!tab) {
    return refuse('tab_not_found')
  }
  const root = command.ratios
    ? withPaneSplitRatios(tab.panes.root!, command.ratios)
    : command.root && samePanesIgnoringRatios(tab.panes.root!, command.root)
      ? command.root
      : null
  if (!root) {
    return refuse('pane_structure_changed')
  }
  return updateTab(model, command.workspace, { ...tab, panes: { ...tab.panes, root } })
}

export function equalizePanes(
  model: WorkspaceLayoutModel,
  command: CommandOf<'equalizePanes'>
): Applied {
  const tab = paneTab(model, command)
  if (!tab) {
    return refuse('tab_not_found')
  }
  return updateTab(model, command.workspace, {
    ...tab,
    panes: { ...tab.panes, root: equalizeLayout(tab.panes.root!) }
  })
}

export function renamePane(model: WorkspaceLayoutModel, command: CommandOf<'renamePane'>): Applied {
  const tab = paneTab(model, command)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (!layoutContainsLeafId(tab.panes.root, command.leafId)) {
    return refuse('pane_not_found')
  }
  const workspace = model.workspaces[command.workspace]!
  const leaf = { ...workspace.leaves?.[command.leafId] }
  delete leaf.title
  return applied(
    withWorkspace(
      model,
      command.workspace,
      setLeaf(
        workspace,
        command.leafId,
        command.title === null ? leaf : { ...leaf, title: command.title }
      )
    )
  )
}

export function setPaneGrid(
  model: WorkspaceLayoutModel,
  command: CommandOf<'setPaneGrid'>
): Applied {
  const tab = paneTab(model, command)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (!layoutContainsLeafId(tab.panes.root, command.leafId)) {
    return refuse('pane_not_found')
  }
  const workspace = model.workspaces[command.workspace]!
  const leaf = workspace.leaves?.[command.leafId]
  const { cols, rows } = command.grid
  if (leaf?.lastGrid?.cols === cols && leaf.lastGrid.rows === rows) {
    return applied(model)
  }
  return applied(
    withWorkspace(
      model,
      command.workspace,
      setLeaf(workspace, command.leafId, { ...leaf, lastGrid: { cols, rows } })
    )
  )
}

export function releasePaneTerminal(
  model: WorkspaceLayoutModel,
  command: CommandOf<'releasePaneTerminal'>
): Applied {
  const tab = paneTab(model, command)
  if (!tab || !layoutContainsLeafId(tab.panes.root, command.leafId)) {
    return refuse('pane_not_found')
  }
  const workspace = model.workspaces[command.workspace]!
  const leaf = workspace.leaves?.[command.leafId]
  if (leaf?.ptyId !== command.ptyId) {
    return applied(model)
  }
  const { ptyId: _released, incarnationId: _incarnation, ...rest } = leaf
  return applied(withWorkspace(model, command.workspace, setLeaf(workspace, command.leafId, rest)))
}

/** Drag-out (#25380): only the tree moves; the pane's data and scrollback are keyed by its id. */
export function movePaneToNewTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'movePaneToNewTab'>,
  context: LayoutContext
): Applied {
  const tab = paneTab(model, command)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (!layoutContainsLeafId(tab.panes.root, command.leafId)) {
    return refuse('pane_not_found')
  }
  const detach = command.windowDetach
  if (!detach && leafIdsOf(tab).length < 2) {
    return refuse('last_pane')
  }
  const { leafId } = command
  const workspace = bindDetachedLeaf(model.workspaces[command.workspace]!, leafId, detach)
  // An unbound pane's shell starts in the new tab, so it starts in the pane's folder.
  const startupCwd =
    (!workspace.leaves?.[leafId]?.ptyId && detach?.startupCwd) || tab.terminal.startupCwd
  const id = detach?.tabId ?? context.mintId()
  const terminals = workspace.tabs.flatMap((entry) => (entry.kind === 'terminal' ? [entry] : []))
  const ordinal = getNextTerminalOrdinal(
    terminals.map((entry) => ({ defaultTitle: entry.terminal.defaultTitle, title: '' }))
  )
  const moved: LayoutTerminalTab = {
    id,
    entityId: id,
    createdAt: context.now(),
    customTitle: null,
    color: null,
    ...(tab.panes.chatLeafId === leafId ? { viewMode: 'chat' as const } : {}),
    kind: 'terminal',
    terminal: {
      defaultTitle: `Terminal ${ordinal}`,
      ...(startupCwd ? { startupCwd } : {}),
      ...(tab.terminal.shellOverride ? { shellOverride: tab.terminal.shellOverride } : {})
    },
    panes: {
      root: { type: 'leaf', leafId },
      ...(tab.panes.chatLeafId === leafId ? { chatLeafId: leafId } : {})
    }
  }
  const source: LayoutTerminalTab = {
    ...tab,
    panes: { ...tab.panes, root: removeLayoutLeaf(tab.panes.root, leafId) }
  }
  if (source.panes.chatLeafId === leafId) {
    delete source.panes.chatLeafId
  }
  const sourceGroup = workspace.groups.find((group) => group.tabOrder.includes(tab.id))
  const withSource = {
    ...workspace,
    tabs: workspace.tabs.map((entry) => (entry.id === tab.id ? source : entry))
  }
  const placed = placeNewTab(
    withSource,
    command.workspace,
    moved,
    {
      groupId: command.groupId ?? sourceGroup?.id,
      index: command.index,
      afterTabId: command.index === undefined ? tab.id : undefined
    },
    context
  )
  return applied(withWorkspace(model, command.workspace, placed), {
    tabId: id,
    ...(detach ? { ptyId: placed.leaves?.[leafId]?.ptyId ?? null } : {})
  })
}

/** The window's terminal outranks a stale binding here; a stale copy's incarnation is dropped. */
function bindDetachedLeaf(
  workspace: WorkspaceLayout,
  leafId: string,
  detach: WindowPaneDetach | undefined
): WorkspaceLayout {
  const leaf = workspace.leaves?.[leafId]
  if (!detach?.ptyId || leaf?.ptyId === detach.ptyId) {
    return workspace
  }
  if (!leaf?.ptyId) {
    return setLeaf(workspace, leafId, { ...leaf, ptyId: detach.ptyId })
  }
  const { incarnationId: _stale, ...rest } = leaf
  return setLeaf(workspace, leafId, { ...rest, ptyId: detach.ptyId })
}
