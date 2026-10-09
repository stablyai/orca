// Runtime-internal transitions (design 2.3): facts the runtime sees about processes, hosts and
// owners, applied through the same module as commands. No client sends these. Transitions whose
// producer arrives later (orphan adoption, legacy worker recovery, client-hosted pages, agent
// launch verdicts, sleep capture, partition moves) ship with that producer's PR.

import { isSameTerminal } from './terminal-owner-invariants'
import { omitStoredFields } from './stored-record-fields'
import {
  applied,
  locatePane,
  refuse,
  setLeaf,
  type Applied
} from './workspace-layout-command-steps'
import { updateLegacyPersistence } from './workspace-layout-legacy-persistence'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { retireExitedSurface, withWorkspace, type ExitedSurface } from './workspace-layout-removal'
import { removeWorkspaces, renameWorkspace } from './workspace-layout-owner-transitions'

export type LayoutTransition =
  | {
      type: 'processStarted'
      workspace: string
      paneKey: string
      ptyId: string
      incarnationId?: string
    }
  | { type: 'processExited'; surface: ExitedSurface }
  | { type: 'sshLeaseTerminated'; ptyIds: string[] }
  | { type: 'ownerRemoved'; workspaces: string[] }
  | { type: 'identityRenamed'; from: string; to: string }

function boundElsewhere(
  model: WorkspaceLayoutModel,
  leafId: string,
  binding: { ptyId: string; incarnationId?: string }
): boolean {
  return Object.values(model.workspaces).some((workspace) =>
    Object.entries(workspace.leaves ?? {}).some(
      ([otherId, leaf]) =>
        otherId !== leafId &&
        isSameTerminal({ ptyId: leaf.ptyId, incarnationId: leaf.incarnationId }, binding)
    )
  )
}

/** Binds the started terminal to the pane that was starting; one terminal never shows in two panes. */
function processStarted(
  model: WorkspaceLayoutModel,
  transition: Extract<LayoutTransition, { type: 'processStarted' }>
): Applied {
  const workspace = model.workspaces[transition.workspace]
  const pane = workspace && locatePane(workspace, transition.paneKey)
  if (!pane) {
    return refuse('pane_not_found')
  }
  if (boundElsewhere(model, pane.leafId, transition)) {
    return refuse('pane_already_bound')
  }
  const leaf = { ...workspace.leaves?.[pane.leafId], ptyId: transition.ptyId }
  if (transition.incarnationId !== undefined) {
    leaf.incarnationId = transition.incarnationId
  }
  return applied(withWorkspace(model, transition.workspace, setLeaf(workspace, pane.leafId, leaf)))
}

/** Loss of an SSH lease unbinds its panes; it is not evidence the remote process exited. */
function sshLeaseTerminated(model: WorkspaceLayoutModel, ptyIds: readonly string[]): Applied {
  let next = model
  for (const [key, workspace] of Object.entries(model.workspaces)) {
    let updated = workspace
    for (const [leafId, leaf] of Object.entries(workspace.leaves ?? {})) {
      if (leaf.ptyId !== undefined && ptyIds.includes(leaf.ptyId)) {
        updated = setLeaf(updated, leafId, omitStoredFields(leaf, ['ptyId']))
      }
    }
    next = updated === workspace ? next : withWorkspace(next, key, updated)
  }
  return applied(next)
}

function applyTransition(
  model: WorkspaceLayoutModel,
  transition: Exclude<LayoutTransition, { type: 'processExited' }>
): Applied {
  switch (transition.type) {
    case 'processStarted':
      return processStarted(model, transition)
    case 'sshLeaseTerminated':
      return sshLeaseTerminated(model, transition.ptyIds)
    case 'ownerRemoved':
      return applied(removeWorkspaces(model, transition.workspaces))
    case 'identityRenamed': {
      const renamedModel = renameWorkspace(model, transition.from, transition.to)
      return renamedModel ? applied(renamedModel) : refuse('workspace_exists')
    }
  }
}

export function applyLayoutTransition(
  model: WorkspaceLayoutModel,
  transition: LayoutTransition
): Applied {
  if (transition.type === 'processExited') {
    const retired = retireExitedSurface(model, transition.surface)
    // An accepted exit advances the revision even when its pane was already gone, as today.
    return applied(
      retired ? updateLegacyPersistence(model, retired, [transition.surface.worktreeId]) : model
    )
  }
  const result = applyTransition(model, transition)
  return result.ok ? { ...result, model: updateLegacyPersistence(model, result.model) } : result
}
