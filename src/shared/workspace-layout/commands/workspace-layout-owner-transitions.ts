// Keep records within their workspace so removal and rename carry pane data and closed-tab records automatically.

import { filterRecord } from '../persistence/stored-record-fields'
import { removeGroupLayoutLeaf } from '../tab-groups/tab-group-layout-tree'
import type { LayoutEditorView } from '../editor-tabs/layout-editor-view'
import type { LayoutTab, WorkspaceLayout, WorkspaceLayoutModel } from '../workspace-layout-model'

type KeyedRecord<T> = Record<string, T> | undefined

export function removeWorkspaces(
  model: WorkspaceLayoutModel,
  keys: readonly string[]
): WorkspaceLayoutModel {
  const workspaces = rehomeRemovedEditorViews(model.workspaces, new Set(keys))
  for (const key of keys) {
    delete workspaces[key]
  }
  const { records } = model
  return {
    ...model,
    workspaces,
    records: {
      ...records,
      defaultTabsAppliedByWorkspace: filterRecord(
        records.defaultTabsAppliedByWorkspace,
        (key) => !keys.includes(key)
      ),
      clientHostedBrowserPagesByWorkspace: filterRecord(
        records.clientHostedBrowserPagesByWorkspace,
        (key) => !keys.includes(key)
      )
    }
  }
}

function withoutRemovedContentViews(
  workspace: WorkspaceLayout,
  removed: ReadonlySet<string>
): WorkspaceLayout {
  const closed = new Set(
    Object.entries(workspace.editorViews ?? {}).flatMap(([id, view]) =>
      view.file.worktreeId && removed.has(view.file.worktreeId) ? [id] : []
    )
  )
  if (!closed.size) {
    return workspace
  }
  let groupLayout = workspace.groupLayout
  const groups = workspace.groups.flatMap((group) => {
    const tabOrder = group.tabOrder.filter((id) => !closed.has(id))
    if (tabOrder.length) {
      return [{ ...group, tabOrder }]
    }
    groupLayout = groupLayout
      ? (removeGroupLayoutLeaf(groupLayout, group.id) ?? undefined)
      : undefined
    return []
  })
  return {
    ...workspace,
    tabs: workspace.tabs.filter((tab) => !closed.has(tab.id)),
    groups,
    groupLayout,
    editorViews: filterRecord(workspace.editorViews, (id) => !closed.has(id))
  }
}

type RetainedEditView = { tab: LayoutTab; view: LayoutEditorView; groupId?: string }
function retainedEditViews(
  source: WorkspaceLayoutModel['workspaces'],
  removed: ReadonlySet<string>
): Map<string, RetainedEditView[]> {
  const byOwner = new Map<string, RetainedEditView[]>()
  for (const key of removed) {
    const workspace = source[key]
    if (!workspace) {
      continue
    }
    const groupByTabId = new Map(
      workspace.groups.flatMap((group) => group.tabOrder.map((id) => [id, group.id] as const))
    )
    for (const tab of workspace.tabs) {
      const view = workspace.editorViews?.[tab.id]
      const owner = view?.file.worktreeId
      if (!view || view.view.mode !== 'edit' || !owner || owner === key || removed.has(owner)) {
        continue
      }
      const views = byOwner.get(owner) ?? []
      views.push({ tab, view, groupId: groupByTabId.get(tab.id) })
      byOwner.set(owner, views)
    }
  }
  return byOwner
}

/** A removed placement transfers writable views; removing their content owner closes all views. */
function rehomeRemovedEditorViews(
  source: WorkspaceLayoutModel['workspaces'],
  removed: ReadonlySet<string>
): WorkspaceLayoutModel['workspaces'] {
  const workspaces = Object.fromEntries(
    Object.entries(source).flatMap(([key, workspace]) =>
      removed.has(key) ? [] : [[key, withoutRemovedContentViews(workspace, removed)]]
    )
  )
  const usedGroupIds = new Set(
    Object.values(workspaces).flatMap((workspace) => workspace.groups.map((group) => group.id))
  )
  for (const [owner, transfers] of retainedEditViews(source, removed)) {
    const target = workspaces[owner] ?? { worktreeId: owner, tabs: [], groups: [] }
    const shown = new Set(target.tabs.map((tab) => tab.entityId))
    const accepted = transfers.filter(({ tab }) => {
      if (shown.has(tab.entityId)) {
        return false
      }
      shown.add(tab.entityId)
      return true
    })
    if (!accepted.length) {
      continue
    }
    const sourceGroupId = accepted[0]!.groupId
    const groupId =
      target.groups[0]?.id ??
      (sourceGroupId && !usedGroupIds.has(sourceGroupId)
        ? sourceGroupId
        : `restored-editor:${owner}`)
    usedGroupIds.add(groupId)
    const addedIds = accepted.map(({ tab }) => tab.id)
    const groups = target.groups.length
      ? target.groups.map((group) =>
          group.id === groupId ? { ...group, tabOrder: [...group.tabOrder, ...addedIds] } : group
        )
      : [{ id: groupId, tabOrder: addedIds }]
    const fileKeys = new Set(
      target.editorFiles?.map((file) =>
        JSON.stringify([file.filePath, file.runtimeEnvironmentId ?? null])
      )
    )
    const files = accepted.flatMap(({ view }) => {
      const { worktreeId: _owner, ...file } = view.file
      const key = JSON.stringify([file.filePath, file.runtimeEnvironmentId ?? null])
      if (fileKeys.has(key)) {
        return []
      }
      fileKeys.add(key)
      return [file]
    })
    workspaces[owner] = {
      ...target,
      tabs: [...target.tabs, ...accepted.map(({ tab }) => tab)],
      groups,
      groupLayout: target.groupLayout ?? { type: 'leaf', groupId },
      editorFiles: [...(target.editorFiles ?? []), ...files],
      editorViews: {
        ...target.editorViews,
        ...Object.fromEntries(accepted.map(({ tab, view }) => [tab.id, view]))
      }
    }
  }
  return workspaces
}

const renamed = (value: string, from: string, to: string) => (value === from ? to : value)

/** Rename the workspace key, worktree ID and keyed records; refuse an occupied destination rather than merging layouts. */
export function renameWorkspace(
  model: WorkspaceLayoutModel,
  from: string,
  to: string
): WorkspaceLayoutModel | null {
  const workspace = model.workspaces[from]
  if (!workspace || from === to) {
    return model
  }
  if (model.workspaces[to]) {
    return null
  }
  const workspaces = {
    ...model.workspaces,
    [to]: { ...workspace, worktreeId: renamed(workspace.worktreeId, from, to) }
  }
  delete workspaces[from]
  const rekey = <T>(record: KeyedRecord<T>): KeyedRecord<T> =>
    record &&
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [renamed(key, from, to), value])
    )
  return {
    ...model,
    workspaces,
    records: {
      ...model.records,
      defaultTabsAppliedByWorkspace: rekey(model.records.defaultTabsAppliedByWorkspace),
      clientHostedBrowserPagesByWorkspace: rekey(model.records.clientHostedBrowserPagesByWorkspace)
    },
    legacy: { ...model.legacy, terminalRowOwners: rekey(model.legacy.terminalRowOwners)! }
  }
}
