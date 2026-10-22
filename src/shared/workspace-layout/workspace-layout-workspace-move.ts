// Moving editor tabs to another workspace of the same partition: a restored tab whose file the
// window found under a sibling workspace (F42). The window resolves that owner; main moves the tabs.

import {
  applied,
  findTab,
  placeNewTab,
  refuse,
  workspaceOrEmpty,
  type Applied
} from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import { sameEditorFile } from './workspace-layout-editor-tab-file'
import type { LayoutTab, WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { removeTabFromWorkspace, withWorkspace } from './workspace-layout-removal'
import { withoutKey } from './stored-record-fields'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'

export const EDITOR_KINDS: ReadonlySet<LayoutTab['kind']> = new Set<LayoutTab['kind']>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

/**
 * Whether the group shows this tab's file in another tab of its kind. A layout-owner window draws
 * only one of the two, so a close could not reach the other: main never puts a second one there.
 */
export function groupShowsTabFile(
  workspace: WorkspaceLayout,
  groupId: string,
  tab: Pick<LayoutTab, 'id' | 'kind' | 'entityId'>
): boolean {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !EDITOR_KINDS.has(tab.kind)) {
    return false
  }
  return (
    workspace.groups
      .find((group) => group.id === groupId)
      ?.tabOrder.some((id) => {
        const other = id === tab.id ? undefined : findTab(workspace, id)
        return other?.kind === tab.kind && other.entityId === tab.entityId
      }) === true
  )
}

type Move = CommandOf<'moveTabToWorkspace'>['tabs'][number] & { tab: LayoutTab }

/** The tab a group already shows for each file, by kind and entity: a layout-owner build's fold. */
function shownFiles(workspace: WorkspaceLayout, groupId: string): Map<string, string> {
  const shown = new Map<string, string>()
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return shown
  }
  for (const id of workspace.groups.find((group) => group.id === groupId)?.tabOrder ?? []) {
    const tab = findTab(workspace, id)
    if (tab && EDITOR_KINDS.has(tab.kind)) {
      shown.set(`${tab.kind}\0${tab.entityId}`, tab.id)
    }
  }
  return shown
}

/**
 * Each tab leaves its workspace and is appended to `groupId` under its new ids, with its view (the
 * window's new one when it sends one); the file's record moves with it. Only editor tabs move: no
 * other kind's records follow it. In a layout-owner build a tab whose file the group already shows
 * (or an earlier moved tab does) folds into that tab, as the loader folds a saved duplicate.
 */
export function moveTabToWorkspace(
  model: WorkspaceLayoutModel,
  command: CommandOf<'moveTabToWorkspace'>,
  context: LayoutContext
): Applied {
  const { workspace: fromKey, toWorkspace: toKey } = command
  const distinct = (ids: string[]) => new Set(ids).size === ids.length
  if (
    fromKey === toKey ||
    command.tabs.length === 0 ||
    !distinct(command.tabs.map((move) => move.tabId)) ||
    !distinct(command.tabs.map((move) => move.newTabId))
  ) {
    return refuse('invalid_params')
  }
  const sourceLayout = model.workspaces[fromKey]
  if (!sourceLayout) {
    return refuse('workspace_not_found')
  }
  let source = sourceLayout
  let target = workspaceOrEmpty(model, toKey)
  const shown = shownFiles(target, command.groupId)
  const moves: Move[] = []
  const folds: LayoutTab[] = []
  // Where the last tab named lands: under its new id, or as the tab it folded into.
  let landed = command.groupId
  for (const move of command.tabs) {
    const tab = findTab(source, move.tabId)
    if (!tab) {
      return refuse('tab_not_found')
    }
    if (!EDITOR_KINDS.has(tab.kind)) {
      return refuse('invalid_params')
    }
    const key = `${tab.kind}\0${move.newEntityId}`
    const kept = shown.get(key)
    if (kept !== undefined) {
      folds.push(tab)
      landed = kept
      continue
    }
    const held = Object.values(model.workspaces).some((workspace) =>
      workspace.tabs.some((entry) => entry.id === move.newTabId && entry !== tab)
    )
    if (held) {
      return refuse('tab_exists')
    }
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      shown.set(key, move.newTabId)
    }
    moves.push({ tab, ...move })
    landed = move.newTabId
  }
  if (!target.groups.some((group) => group.id === command.groupId)) {
    if (target.groups.length > 0) {
      return refuse('group_not_found')
    }
    // A workspace with no group takes the window's, as openEditorTab does.
    target = { ...target, groups: [{ id: command.groupId, tabOrder: [] }] }
  }
  for (const tab of folds) {
    source = withoutTab(source, tab.id)
  }
  for (const { tab, newTabId, newEntityId, view: newView } of moves) {
    const view = newView ?? source.editorViews?.[tab.id]
    source = withoutTab(source, tab.id)
    const end = target.groups.find((group) => group.id === command.groupId)?.tabOrder.length ?? 0
    target = placeNewTab(
      target,
      toKey,
      { ...tab, id: newTabId, entityId: newEntityId },
      { groupId: command.groupId, index: end },
      context
    )
    if (view) {
      target = { ...target, editorViews: { ...target.editorViews, [newTabId]: view } }
    }
  }
  if (command.file) {
    ;({ source, target } = moveEditorFile(source, target, command.file))
  }
  const next = withWorkspace(withWorkspace(model, fromKey, source), toKey, target)
  return applied(next, { tabId: landed, groupId: command.groupId })
}

/** The workspace without the tab and its view. */
function withoutTab(workspace: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const removed = removeTabFromWorkspace(workspace, tabId)
  return removed.editorViews
    ? { ...removed, editorViews: withoutKey(removed.editorViews, tabId) }
    : removed
}

/** The file's record moves with its tabs. */
function moveEditorFile(
  source: WorkspaceLayout,
  target: WorkspaceLayout,
  file: NonNullable<CommandOf<'moveTabToWorkspace'>['file']>
): { source: WorkspaceLayout; target: WorkspaceLayout } {
  const others = (files: WorkspaceLayout['editorFiles']) =>
    files?.filter((entry) => !sameEditorFile(entry, file))
  const sourceFiles = others(source.editorFiles)
  return {
    source: sourceFiles ? { ...source, editorFiles: sourceFiles } : source,
    target: { ...target, editorFiles: [...(others(target.editorFiles) ?? []), file] }
  }
}
