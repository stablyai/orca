// Editor tabs follow a file the window renamed or moved on disk. The window picks each file's new
// id (a bare path, an owner-qualified id, a diff id…), so main renames by the window's ids rather
// than re-deriving them from paths; two open files are never merged into one tab.

import { applied, refuse, type Applied } from './workspace-layout-command-steps'
import type { CommandOf } from './workspace-layout-command-types'
import type { LayoutEditorFile, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'
import { EDITOR_KINDS } from './workspace-layout-workspace-move'

type Renames = CommandOf<'renameEditorFiles'>['renames']

/**
 * The renames in the command's workspace and in each `alsoIn` one, as one change: refused as a
 * whole when any workspace's would be, so main and the window never keep half a disk move.
 */
export function renameEditorFiles(
  model: WorkspaceLayoutModel,
  command: CommandOf<'renameEditorFiles'>
): Applied {
  const parts = [
    { workspace: command.workspace, renames: command.renames },
    ...(command.alsoIn ?? [])
  ]
  if (new Set(parts.map((part) => part.workspace)).size !== parts.length) {
    return refuse('invalid_params')
  }
  let next = model
  const renamedTabIds: Record<string, string> = {}
  for (const part of parts) {
    if (!next.workspaces[part.workspace]) {
      return refuse('workspace_not_found')
    }
    const step = renameInWorkspace(next, part.workspace, part.renames)
    if (!step.ok) {
      return step
    }
    next = step.model
    Object.assign(renamedTabIds, step.result.renamedTabIds)
  }
  return applied(next, { renamedTabIds })
}

/**
 * Every editor tab showing a renamed file takes its new id, and a tab-bar id that is the file's
 * id follows it too, as the window rekeys them. Refused as a whole when two files would get one
 * id, or a file would take the id of an open one that is not itself renamed. Files no tab shows
 * change nothing but their record.
 */
function renameInWorkspace(
  model: WorkspaceLayoutModel,
  workspaceKey: string,
  renames: Renames
): Applied {
  const workspace = model.workspaces[workspaceKey]
  if (!workspace) {
    return refuse('workspace_not_found')
  }
  const ids = new Map(renames.map((rename) => [rename.fileId, rename.newFileId]))
  const targets = new Set(ids.values())
  if (ids.size !== renames.length || targets.size !== ids.size) {
    return refuse('invalid_params')
  }
  const renamed = (id: string) => ids.get(id) ?? id
  const editorTabs = workspace.tabs.filter((tab) => EDITOR_KINDS.has(tab.kind))
  if (editorTabs.some((tab) => targets.has(tab.entityId) && !ids.has(tab.entityId))) {
    return refuse('invalid_params')
  }
  const renamedTabIds = new Map<string, string>()
  for (const tab of editorTabs) {
    if (renamed(tab.id) !== tab.id) {
      renamedTabIds.set(tab.id, renamed(tab.id))
    }
  }
  const newTabIds = new Set(renamedTabIds.values())
  const taken = Object.values(model.workspaces).some((entry) =>
    entry.tabs.some((tab) => newTabIds.has(tab.id) && !renamedTabIds.has(tab.id))
  )
  if (taken) {
    return refuse('tab_exists')
  }
  const tabId = (id: string) => renamedTabIds.get(id) ?? id
  const tabs = workspace.tabs.map((tab) =>
    EDITOR_KINDS.has(tab.kind) && (ids.has(tab.entityId) || renamedTabIds.has(tab.id))
      ? { ...tab, id: tabId(tab.id), entityId: renamed(tab.entityId) }
      : tab
  )
  const groups = workspace.groups.map((group) =>
    group.tabOrder.some((id) => renamedTabIds.has(id))
      ? { ...group, tabOrder: group.tabOrder.map(tabId) }
      : group
  )
  // A renamed tab's view follows its file to the new path.
  const views = new Map(
    renames.flatMap((rename) => (rename.view ? [[rename.newFileId, rename.view] as const] : []))
  )
  const entityOf = new Map(tabs.map((tab) => [tab.id, tab.entityId]))
  const editorViews =
    workspace.editorViews &&
    Object.fromEntries(
      Object.entries(workspace.editorViews).map(([id, view]) => [
        tabId(id),
        views.get(entityOf.get(tabId(id)) ?? '') ?? view
      ])
    )
  const editorFiles = renamedEditorFiles(
    workspace.editorFiles,
    renames,
    new Set(tabs.map((tab) => tab.entityId))
  )
  return applied(
    withWorkspace(model, workspaceKey, {
      ...workspace,
      tabs,
      groups,
      ...(editorViews ? { editorViews } : {}),
      ...(editorFiles ? { editorFiles } : {})
    }),
    { renamedTabIds: Object.fromEntries(renamedTabIds) }
  )
}

/** Each renamed edit-mode file's record, in its old record's place; a new one only for a tab main holds. */
function renamedEditorFiles(
  files: LayoutEditorFile[] | undefined,
  renames: Renames,
  heldEntityIds: ReadonlySet<string>
): LayoutEditorFile[] | undefined {
  const moves = renames.flatMap((rename) =>
    rename.record ? [{ ...rename.record, newFileId: rename.newFileId }] : []
  )
  if (moves.length === 0) {
    return files
  }
  const byOldPath = new Map(moves.map((move) => [move.fromFilePath, move.file]))
  const kept = (files ?? []).map((file) => byOldPath.get(file.filePath) ?? file)
  // A record main never got is the window's now too, when main shows the file.
  const missing = moves.filter(
    (move) =>
      heldEntityIds.has(move.newFileId) &&
      !files?.some((file) => file.filePath === move.fromFilePath)
  )
  return files === undefined && missing.length === 0
    ? files
    : [...kept, ...missing.map((move) => move.file)]
}
