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
import type { LayoutTab, WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { removeTabFromWorkspace, withWorkspace } from './workspace-layout-removal'
import { withoutKey } from './stored-record-fields'

export const EDITOR_KINDS: ReadonlySet<LayoutTab['kind']> = new Set<LayoutTab['kind']>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

/**
 * Each tab leaves its workspace and is appended to `groupId` under its new ids, as the window
 * moves it; the file's record moves with it. A tab already moved (the window's save got there
 * first) is skipped. Only editor tabs move: no other kind's records follow it.
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
    !distinct(command.tabs.map((move) => move.tabId)) ||
    !distinct(command.tabs.map((move) => move.newTabId))
  ) {
    return refuse('invalid_params')
  }
  let source = model.workspaces[fromKey]!
  let target = workspaceOrEmpty(model, toKey)
  const moves: { tab: LayoutTab; newTabId: string; newEntityId: string }[] = []
  for (const move of command.tabs) {
    const tab = findTab(source, move.tabId)
    if (!tab) {
      const moved = findTab(target, move.newTabId)?.entityId === move.newEntityId
      if (moved) {
        continue
      }
      return refuse('tab_not_found')
    }
    if (!EDITOR_KINDS.has(tab.kind)) {
      return refuse('invalid_params')
    }
    const held = Object.values(model.workspaces).some((workspace) =>
      workspace.tabs.some((entry) => entry.id === move.newTabId && entry !== tab)
    )
    if (held) {
      return refuse('tab_exists')
    }
    moves.push({ tab, ...move })
  }
  if (moves.length === 0) {
    return applied(model, { groupId: command.groupId })
  }
  if (!target.groups.some((group) => group.id === command.groupId)) {
    if (target.groups.length > 0) {
      return refuse('group_not_found')
    }
    // A workspace with no group takes the window's, as openEditorTab does.
    target = { ...target, groups: [{ id: command.groupId, tabOrder: [] }] }
  }
  for (const { tab, newTabId, newEntityId } of moves) {
    const view = source.editorViews?.[tab.id]
    source = removeTabFromWorkspace(source, tab.id)
    if (source.editorViews) {
      source = { ...source, editorViews: withoutKey(source.editorViews, tab.id) }
    }
    const end = target.groups.find((group) => group.id === command.groupId)!.tabOrder.length
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
  return applied(next, { tabId: moves.at(-1)!.newTabId, groupId: command.groupId })
}

/** The file's record moves with its tabs. */
function moveEditorFile(
  source: WorkspaceLayout,
  target: WorkspaceLayout,
  file: NonNullable<CommandOf<'moveTabToWorkspace'>['file']>
): { source: WorkspaceLayout; target: WorkspaceLayout } {
  const others = (files: WorkspaceLayout['editorFiles']) =>
    files?.filter((entry) => entry.filePath !== file.filePath)
  const sourceFiles = others(source.editorFiles)
  return {
    source: sourceFiles ? { ...source, editorFiles: sourceFiles } : source,
    target: { ...target, editorFiles: [...(others(target.editorFiles) ?? []), file] }
  }
}
