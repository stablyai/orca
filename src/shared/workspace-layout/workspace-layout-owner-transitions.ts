// Keep records within their workspace so removal and rename carry pane data and closed-tab records automatically.

import { filterRecord } from './stored-record-fields'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

type KeyedRecord<T> = Record<string, T> | undefined

export function removeWorkspaces(
  model: WorkspaceLayoutModel,
  keys: readonly string[]
): WorkspaceLayoutModel {
  const workspaces = { ...model.workspaces }
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
