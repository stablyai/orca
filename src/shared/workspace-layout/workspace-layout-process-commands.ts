// Commands that start, restart, sleep or wake terminals. Their layout effect is small (bindings
// and sleeping records); the runtime runs the returned effects after replying.

import { isPaneSleepRecord } from '../agent-session-resume'
import { omitStoredFields } from './stored-record-fields'
import {
  applied,
  leafIdsOf,
  locatePane,
  refuse,
  setLeaf,
  type Applied
} from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import {
  paneKeyOf,
  type LayoutLeaf,
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

/** A slept pane's record or a running agent's resume record: either says how its agent resumes. */
function hasResumeRecord(leaf: LayoutLeaf | undefined): boolean {
  return leaf?.sleeping !== undefined || leaf?.resume !== undefined
}

/**
 * Idempotent: starts or restores a pane that has no live terminal. A bound pane is live unless the
 * runtime knows otherwise (a start status, or an ended terminal), so its binding names what it
 * restores from; a live pane, or one whose start is in flight, is left alone, and only
 * restartPane replaces a terminal. The runtime's start
 * resumes the agent a pane's sleeping record names, so a slept pane starts from its record.
 */
export function startPane(
  model: WorkspaceLayoutModel,
  command: CommandOf<'startPane'>,
  context: LayoutContext
): Applied {
  const workspace = model.workspaces[command.workspace]!
  const pane = locatePane(workspace, command.paneKey)
  if (!pane) {
    return refuse('pane_not_found')
  }
  const leaf = workspace.leaves?.[pane.leafId]
  if (leaf?.ptyId && context.retiresBinding?.(command.paneKey, leaf.ptyId)) {
    return restartPane(model, { ...command, type: 'restartPane' })
  }
  // A live terminal comes first: a running agent's resume record does not make its pane asleep.
  const live = leaf?.ptyId && (context.isBindingLive?.(command.paneKey, leaf.ptyId) ?? true)
  if (live || context.isStarting?.(pane.leafId)) {
    return applied(model)
  }
  return applied(model, {}, { startPaneKeys: [command.paneKey] }, { [pane.leafId]: null })
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
    { stopPtyIds: leaf.ptyId ? [leaf.ptyId] : [], startPaneKeys: [command.paneKey] },
    { [pane.leafId]: null }
  )
}

/** Stops the terminals (unless `recordOnly`) and records how to resume each agent; panes and bindings stay. */
export function sleep(model: WorkspaceLayoutModel, command: CommandOf<'sleep'>): Applied {
  let workspace = model.workspaces[command.workspace]!
  const panes = workspacePanes(workspace)
  const targets = command.paneKeys
    ? panes.filter((pane) => command.paneKeys!.includes(pane.paneKey))
    : panes
  const stopPtyIds = command.recordOnly
    ? []
    : targets.flatMap((pane) => workspace.leaves?.[pane.leafId]?.ptyId ?? [])
  for (const { paneKey, leafId } of targets) {
    const record = command.records.find((entry) => entry.paneKey === paneKey)
    if (record) {
      const kept = omitStoredFields(workspace.leaves?.[leafId] ?? {}, ['sleeping', 'resume'])
      const stored = omitStoredFields(record, ['paneKey', 'tabId', 'worktreeId'])
      // A recordOnly capture of a running agent ('live'/'quit') is a resume record, not a sleep.
      const next = isPaneSleepRecord(stored) ? { sleeping: stored } : { resume: stored }
      workspace = setLeaf(workspace, leafId, { ...kept, ...next })
    }
  }
  return applied(
    withWorkspace(model, command.workspace, workspace),
    { slept: targets.map((pane) => pane.paneKey) },
    { stopPtyIds }
  )
}

/**
 * Without `recordOnly`, starts the slept panes and keeps their records: the runtime's start resumes
 * from them and keeps them in the pane-owned form, so a failed start or a host crash resumes again.
 */
export function wake(model: WorkspaceLayoutModel, command: CommandOf<'wake'>): Applied {
  let workspace = model.workspaces[command.workspace]!
  // A recordOnly wake drops either record (how a live one is cleared); a start wakes only slept panes.
  const woken = workspacePanes(workspace).filter((pane) => {
    const leaf = workspace.leaves?.[pane.leafId]
    return (
      (!command.paneKeys || command.paneKeys.includes(pane.paneKey)) &&
      (command.recordOnly ? hasResumeRecord(leaf) : leaf?.sleeping !== undefined)
    )
  })
  const paneKeys = woken.map((pane) => pane.paneKey)
  if (!command.recordOnly) {
    return applied(model, { woken: paneKeys }, { startPaneKeys: paneKeys })
  }
  for (const { leafId } of woken) {
    workspace = setLeaf(
      workspace,
      leafId,
      omitStoredFields(workspace.leaves![leafId]!, ['sleeping', 'resume'])
    )
  }
  return applied(withWorkspace(model, command.workspace, workspace), { woken: paneKeys })
}
