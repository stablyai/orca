// Retire proven exits unless the failure must remain visible. Negative codes and attach absence only unbind; neither proves process exit.

import { isProvenProcessExit } from '../terminal-exit-cause'
import { omitStoredFields } from './stored-record-fields'
import { applied, leafIdsOf, setLeaf, type Applied } from './workspace-layout-command-steps'
import { updateLegacyPersistence } from './workspace-layout-legacy-persistence'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import {
  locateExitedSurface,
  retireTerminalPane,
  withWorkspace,
  type ExitedSurface
} from './workspace-layout-removal'

export type ProcessExitFacts = {
  exitCode: number
  /** The process ran on this machine, not over SSH or on a runtime server. */
  local: boolean
  /** The pane's current start attempt spawned it: not a reattach or a cold restore. */
  spawnedFresh: boolean
  /** Another pane of the tab already had a terminal when this pane connected. */
  tabHadPaneAtConnect: boolean
  /** This pane's terminal was restored rather than started for it. */
  restored: boolean
  inputWritten: boolean
  outputReceived: boolean
  /** Attach found no process: never proof that it exited, whatever the code. */
  attachAbsent?: boolean
}

type ExitVerdict = 'retire' | 'keep' | 'unbind'

function exitVerdict(facts: ProcessExitFacts, paneCount: number): ExitVerdict {
  if (facts.attachAbsent || !isProvenProcessExit(facts.exitCode)) {
    return 'unbind'
  }
  if (facts.local && facts.exitCode !== 0) {
    return 'keep'
  }
  if (facts.inputWritten) {
    return 'retire'
  }
  // Before input, keep a sole newborn or a silent unrestored split into a live tab. Runtime output includes hidden panes, so visibility is irrelevant.
  if (paneCount <= 1) {
    return facts.spawnedFresh ? 'keep' : 'retire'
  }
  const freshSplit = facts.tabHadPaneAtConnect && !facts.restored && !facts.outputReceived
  return freshSplit ? 'keep' : 'retire'
}

export function applyProcessExit(
  model: WorkspaceLayoutModel,
  surface: ExitedSurface,
  facts: ProcessExitFacts
): Applied {
  const location = locateExitedSurface(model, surface)
  if (location === 'replaced') {
    return applied(model)
  }
  if (location === 'gone') {
    // A proven exit advances the revision even when its pane was already gone, as today.
    return exitVerdict(facts, 1) === 'unbind'
      ? applied(model)
      : applied(updateLegacyPersistence(model, model, [surface.worktreeId]))
  }
  const { leafId } = surface
  switch (exitVerdict(facts, leafIdsOf(location.tab).length)) {
    case 'keep':
      return applied(model, {}, {}, { [leafId]: 'exited' })
    case 'unbind': {
      const workspace = model.workspaces[location.workspaceKey]!
      const leaf = omitStoredFields(workspace.leaves?.[leafId] ?? {}, ['ptyId', 'incarnationId'])
      const next = withWorkspace(model, location.workspaceKey, setLeaf(workspace, leafId, leaf))
      return applied(updateLegacyPersistence(model, next), {}, {}, { [leafId]: null })
    }
    case 'retire': {
      const retired = retireTerminalPane(model, location, leafId)
      return applied(
        updateLegacyPersistence(model, retired, [surface.worktreeId]),
        {},
        {},
        { [leafId]: null }
      )
    }
  }
}
