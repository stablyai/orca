// Commands that start, restart, sleep or wake terminals. Their layout effect is small (bindings
// and sleeping records); the runtime runs the returned effects after replying.

import { omitStoredFields } from './stored-record-fields'
import {
  applied,
  leafIdsOf,
  locatePane,
  refuse,
  setLeaf,
  type Applied
} from './workspace-layout-command-steps'
import type { CommandOf } from './workspace-layout-command-types'
import {
  paneKeyOf,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'

/** Every pane of the workspace: its key (what commands name) and its leaf (what keys its data). */
function workspacePanes(workspace: WorkspaceLayout): { paneKey: string; leafId: string }[] {
  return workspace.tabs.flatMap((tab) =>
    tab.kind === 'terminal'
      ? leafIdsOf(tab).map((leafId) => ({ paneKey: paneKeyOf(tab.entityId, leafId), leafId }))
      : []
  )
}

/** Idempotent: starts or restores a pane that has no live terminal. */
export function startPane(model: WorkspaceLayoutModel, command: CommandOf<'startPane'>): Applied {
  const workspace = model.workspaces[command.workspace]!
  const pane = locatePane(workspace, command.paneKey)
  if (!pane) {
    return refuse('pane_not_found')
  }
  if (workspace.leaves?.[pane.leafId]?.sleeping) {
    return refuse('pane_sleeping')
  }
  return applied(model, {}, { startPaneKeys: [command.paneKey] })
}

/** Stops then starts in place: the pane keeps its id, its terminal binding is cleared until the new one starts. */
export function restartPane(
  model: WorkspaceLayoutModel,
  command: CommandOf<'restartPane'>
): Applied {
  const workspace = model.workspaces[command.workspace]!
  const pane = locatePane(workspace, command.paneKey)
  if (!pane) {
    return refuse('pane_not_found')
  }
  const leaf = workspace.leaves?.[pane.leafId] ?? {}
  return applied(
    withWorkspace(
      model,
      command.workspace,
      setLeaf(workspace, pane.leafId, omitStoredFields(leaf, ['ptyId', 'incarnationId']))
    ),
    {},
    { stopPtyIds: leaf.ptyId ? [leaf.ptyId] : [], startPaneKeys: [command.paneKey] }
  )
}

/** Stops the terminals and records how to resume each agent; panes and bindings stay. */
export function sleep(model: WorkspaceLayoutModel, command: CommandOf<'sleep'>): Applied {
  let workspace = model.workspaces[command.workspace]!
  const panes = workspacePanes(workspace)
  const targets = command.paneKeys
    ? panes.filter((pane) => command.paneKeys!.includes(pane.paneKey))
    : panes
  const stopPtyIds = targets.flatMap((pane) => workspace.leaves?.[pane.leafId]?.ptyId ?? [])
  for (const { paneKey, leafId } of targets) {
    const record = command.records.find((entry) => entry.paneKey === paneKey)
    if (record) {
      const sleeping = omitStoredFields(record, ['paneKey', 'tabId', 'worktreeId'])
      workspace = setLeaf(workspace, leafId, { ...workspace.leaves?.[leafId], sleeping })
    }
  }
  return applied(
    withWorkspace(model, command.workspace, workspace),
    { slept: targets.map((pane) => pane.paneKey) },
    { stopPtyIds }
  )
}

export function wake(model: WorkspaceLayoutModel, command: CommandOf<'wake'>): Applied {
  let workspace = model.workspaces[command.workspace]!
  const woken = workspacePanes(workspace).filter(
    (pane) =>
      (!command.paneKeys || command.paneKeys.includes(pane.paneKey)) &&
      workspace.leaves?.[pane.leafId]?.sleeping
  )
  for (const { leafId } of woken) {
    workspace = setLeaf(
      workspace,
      leafId,
      omitStoredFields(workspace.leaves![leafId]!, ['sleeping'])
    )
  }
  const paneKeys = woken.map((pane) => pane.paneKey)
  return applied(
    withWorkspace(model, command.workspace, workspace),
    { woken: paneKeys },
    { startPaneKeys: paneKeys }
  )
}
