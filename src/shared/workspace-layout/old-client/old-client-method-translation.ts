// Old layout methods' params as layout commands (design 2.6). Pure: the handler resolves the
// worktree selector and terminal handles, applies the commands and shapes today's reply.

import type { RuntimeMobileSessionTabMove } from '../../runtime-session-contracts'
import { isTerminalLeafId } from '../../stable-pane-id'
import { isValidHostTerminalTabId } from '../../terminal-tab-id'
import type { TerminalPaneSplitDirection } from '../../terminal-tab-types'
import { resolveSessionTabRow } from './old-client-session-tab-rows'
import { tabOrderAnchor } from '../tab-order'
import { collectLayoutLeafIdsInOrder, layoutContainsLeafId } from '../terminal-pane-tree'
import type { ProjectedSessionTabs } from './old-client-session-tabs-projection'
import type { LayoutCommand, LayoutRefusalCode } from '../workspace-layout-command-types'
import {
  paneKeyOf,
  type LayoutTerminalTab,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from '../workspace-layout-model'

/** Errors today's `session.tabs.move` throws, kept so old clients read the same codes. */
export type SessionTabMoveErrorCode =
  | 'tab_not_found'
  | 'target_group_not_found'
  | 'invalid_tab_order'

export type MethodTranslation =
  | { ok: true; commands: LayoutCommand[] }
  | { ok: false; code: LayoutRefusalCode | SessionTabMoveErrorCode }

const to = (...commands: LayoutCommand[]): MethodTranslation => ({ ok: true, commands })
const refused = (code: LayoutRefusalCode | SessionTabMoveErrorCode): MethodTranslation => ({
  ok: false,
  code
})

/**
 * `terminal.create`. An old desktop names the pane it already drew (`tabId`/`leafId`): a pane the
 * model has starts; a new pane in a tab the model has splits that tab; unused ids create a tab
 * with them. Ids that are missing or malformed are minted, as `allocateTerminalPaneIdentity` does.
 */
export function translateTerminalCreate(
  model: WorkspaceLayoutModel,
  workspaceKey: string,
  params: { tabId?: string; leafId?: string; title?: string }
): MethodTranslation {
  const create = (ids: { tabId?: string; leafId?: string }): MethodTranslation =>
    to({
      type: 'createTerminalTab',
      workspace: workspaceKey,
      ...ids,
      ...(params.title ? { title: params.title } : {})
    })
  const tabId = params.tabId?.trim()
  const { leafId } = params
  if (!tabId || !isValidHostTerminalTabId(tabId) || !leafId || !isTerminalLeafId(leafId)) {
    return create({})
  }
  const workspace = model.workspaces[workspaceKey]
  const target = workspace ? resolveSessionTabRow(workspace, tabId)?.tab : undefined
  if (target && target.kind !== 'terminal') {
    return refused('invalid_params')
  }
  if (target && layoutContainsLeafId(target.panes.root, leafId)) {
    return to({
      type: 'startPane',
      workspace: workspaceKey,
      paneKey: paneKeyOf(target.entityId, leafId)
    })
  }
  // Pane ids are unique in the partition: one named elsewhere is not this pane.
  if (paneIdInUse(model, leafId)) {
    return refused('invalid_params')
  }
  if (!target) {
    return create({ tabId, leafId })
  }
  // The desktop sends its tree after, through updatePaneLayout, which moves the pane where it drew it.
  const besideLeafId = collectLayoutLeafIdsInOrder(target.panes.root).at(-1)
  return besideLeafId
    ? to({
        type: 'splitPane',
        workspace: workspaceKey,
        tabId: target.id,
        leafId: besideLeafId,
        direction: 'vertical',
        newLeafId: leafId
      })
    : refused('pane_not_found')
}

function paneIdInUse(model: WorkspaceLayoutModel, leafId: string): boolean {
  return Object.values(model.workspaces).some((workspace) =>
    workspace.tabs.some(
      (tab) => tab.kind === 'terminal' && layoutContainsLeafId(tab.panes.root, leafId)
    )
  )
}

/** `session.tabs.createTerminal`; spawn inputs (command, env, agent) stay with the handler. */
export function translateCreateTerminalTab(
  workspaceKey: string,
  workspace: WorkspaceLayout | undefined,
  params: { afterTabId?: string; targetGroupId?: string; viewMode?: 'terminal' | 'chat' }
): MethodTranslation {
  const after = params.afterTabId && workspace && resolveSessionTabRow(workspace, params.afterTabId)
  return to({
    type: 'createTerminalTab',
    workspace: workspaceKey,
    ...(after ? { afterTabId: after.tab.id } : {}),
    ...(params.targetGroupId ? { groupId: params.targetGroupId } : {}),
    ...(params.viewMode ? { viewMode: params.viewMode } : {})
  })
}

export function translateSetTabProps(
  workspaceKey: string,
  workspace: WorkspaceLayout,
  params: {
    tabId: string
    color?: string | null
    isPinned?: boolean
    viewMode?: 'terminal' | 'chat'
  }
): MethodTranslation {
  const target = resolveSessionTabRow(workspace, params.tabId)
  // Today an unknown tab is a silent `{updated: true}`.
  if (!target) {
    return to()
  }
  return to({
    type: 'setTabProps',
    workspace: workspaceKey,
    tabId: target.tab.id,
    ...(params.color !== undefined ? { color: params.color } : {}),
    ...(params.isPinned !== undefined ? { isPinned: params.isPinned } : {}),
    ...(params.viewMode !== undefined ? { viewMode: params.viewMode } : {})
  })
}

/**
 * `session.tabs.close`: a pane row of a split tab closes its pane; any other terminal row closes
 * its tab, which a pinned tab refuses (`terminal_tab_pinned`) with or without a window, as today.
 * Other kinds close as asked. A row that is already gone closes as already closed (#10747).
 */
export function translateSessionTabClose(
  workspaceKey: string,
  workspace: WorkspaceLayout | undefined,
  params: { tabId: string }
): MethodTranslation {
  const target = workspace ? resolveSessionTabRow(workspace, params.tabId) : null
  if (target?.tab.kind === 'terminal') {
    return target.leafId
      ? translateTerminalClose(workspaceKey, { tab: target.tab, leafId: target.leafId })
      : translateTerminalCloseTab(workspaceKey, { tab: target.tab })
  }
  return to({
    type: 'closeTabs',
    workspace: workspaceKey,
    tabIds: [target?.tab.id ?? params.tabId]
  })
}

/**
 * `session.tabs.move` from a paired client, checked against the snapshot it was shown (`projected`)
 * as today: a `reorder` must be exactly the shown group's tabs, and tabs the client cannot see keep
 * their places. It becomes the moves that produce that order.
 */
export function translateSessionTabMove(
  workspaceKey: string,
  workspace: WorkspaceLayout,
  projected: Pick<ProjectedSessionTabs, 'tabGroups'>,
  params: RuntimeMobileSessionTabMove
): MethodTranslation {
  const shownTabIds = new Set(
    (projected.tabGroups ?? []).flatMap((group) => toTabIds(workspace, group.tabOrder))
  )
  const tab = resolveSessionTabRow(workspace, params.tabId)?.tab
  if (!tab || !shownTabIds.has(tab.id)) {
    return refused('tab_not_found')
  }
  const shown = projected.tabGroups?.find((group) => group.id === params.targetGroupId)
  const target = workspace.groups.find((group) => group.id === params.targetGroupId)
  if (!shown || !target) {
    return refused('target_group_not_found')
  }
  const on = { workspace: workspaceKey, toGroupId: target.id }
  if (params.kind === 'split') {
    return to({
      type: 'splitGroup',
      workspace: workspaceKey,
      tabId: tab.id,
      besideGroupId: target.id,
      direction: params.splitDirection
    })
  }
  const shownOrder = toTabIds(workspace, shown.tabOrder)
  if (params.kind === 'move-to-group') {
    const rowCount = shown.tabOrder.length
    const shownIndex = Math.max(0, Math.min(params.index ?? rowCount, rowCount))
    // A shown index lands before the first tab main holds from that row on (a row it holds no tab
    // for, such as one the window drew before main's frame, places nothing); past the last, the end.
    const before = toTabIds(workspace, shown.tabOrder.slice(shownIndex))[0]
    const index = before === undefined ? target.tabOrder.length : target.tabOrder.indexOf(before)
    return to({
      ...on,
      type: 'moveTab',
      tabId: tab.id,
      index,
      afterTabId: tabOrderAnchor(target.tabOrder, index)
    })
  }
  // A row main holds no tab for (one drawn before main's frame) is named once, and keeps no place.
  const unheld = (rowIds: readonly string[]) =>
    rowIds.filter((rowId) => !resolveSessionTabRow(workspace, rowId))
  const shownUnheld = new Set(unheld(shown.tabOrder))
  const sentUnheld = unheld(params.tabOrder)
  if (
    sentUnheld.length !== shownUnheld.size ||
    new Set(sentUnheld).size !== sentUnheld.length ||
    sentUnheld.some((rowId) => !shownUnheld.has(rowId))
  ) {
    return refused('invalid_tab_order')
  }
  const sent = toTabIds(workspace, params.tabOrder)
  if (
    sent.length !== shownOrder.length ||
    new Set(sent).size !== sent.length ||
    sent.some((id) => !shownOrder.includes(id)) ||
    !sent.includes(tab.id)
  ) {
    return refused('invalid_tab_order')
  }
  const shownSet = new Set(shownOrder)
  let next = 0
  const wanted = target.tabOrder.map((id) => (shownSet.has(id) ? sent[next++]! : id))
  const order = [...target.tabOrder]
  const commands: LayoutCommand[] = []
  wanted.forEach((id, index) => {
    if (order[index] !== id) {
      order.splice(order.indexOf(id), 1)
      order.splice(index, 0, id)
      commands.push({
        ...on,
        type: 'moveTab',
        tabId: id,
        index,
        afterTabId: tabOrderAnchor(wanted, index)
      })
    }
  })
  return to(...commands)
}

function toTabIds(workspace: WorkspaceLayout, rowIds: readonly string[]): string[] {
  return rowIds.flatMap((rowId) => {
    const id = resolveSessionTabRow(workspace, rowId)?.tab.id
    return id ? [id] : []
  })
}

type ResolvedPane = { tab: LayoutTerminalTab; leafId: string }

/** `terminal.split` on a resolved handle; it splits below when no direction is sent, as today. */
export function translateTerminalSplit(
  workspaceKey: string,
  pane: ResolvedPane,
  direction: TerminalPaneSplitDirection | undefined
): MethodTranslation {
  return to({
    type: 'splitPane',
    workspace: workspaceKey,
    tabId: pane.tab.id,
    leafId: pane.leafId,
    direction: direction ?? 'horizontal'
  })
}

/** `terminal.rename`: an empty title resets to the generated one, as today. */
export function translateTerminalRename(
  workspaceKey: string,
  pane: ResolvedPane,
  title: string | null
): MethodTranslation {
  return to({
    type: 'renameTab',
    workspace: workspaceKey,
    tabId: pane.tab.id,
    kind: 'custom',
    title: title || null
  })
}

/**
 * `terminal.close`. Closing a tab's last pane closes the tab, so a pinned tab refuses it
 * (`terminal_tab_pinned`), as the CLI has no force today.
 */
export function translateTerminalClose(
  workspaceKey: string,
  pane: ResolvedPane
): MethodTranslation {
  return collectLayoutLeafIdsInOrder(pane.tab.panes.root).length > 1
    ? to({ type: 'closePane', workspace: workspaceKey, tabId: pane.tab.id, leafId: pane.leafId })
    : translateTerminalCloseTab(workspaceKey, pane)
}

/** `terminal.closeTab` refuses a pinned tab (`terminal_tab_pinned`), as today. */
export function translateTerminalCloseTab(
  workspaceKey: string,
  pane: Pick<ResolvedPane, 'tab'>
): MethodTranslation {
  return to({
    type: 'closeTabs',
    workspace: workspaceKey,
    tabIds: [pane.tab.id],
    refusePinned: true
  })
}
