import { useAppStore, type AppState } from '@/store'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import {
  collectPtyIdsForTab,
  type TerminalTabRetirementState
} from '@/store/slices/terminal-tab-retirement'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../../shared/terminal/pty/lifecycle/terminal-execution-host'

export type KillAllTerminalSurfaceState = TerminalTabRetirementState &
  Pick<AppState, 'activeWorktreeId'>

function runsOnAnotherMachine(host: string | null | undefined): boolean {
  return host === 'foreign' || parseExecutionHostId(host)?.kind === 'runtime'
}

type TabEvidence = { rowPtyId?: string | null; unifiedHost?: string | null }

// Why: a runtime host's tab is that host's to close; closing it here stops a paired machine's work (#38135).
// A tab whose owner is not proven stays open: Kill All must never guess another machine's sessions are ours.
// Indexed once per pass, so a bulk close stays linear in the number of tabs.
function ownedTerminalIdsByWorktree(state: KillAllTerminalSurfaceState): Map<string, Set<string>> {
  const evidenceByWorktree = new Map<string, Map<string, TabEvidence>>()
  const evidenceFor = (worktreeId: string, terminalId: string): TabEvidence => {
    const byTerminal = evidenceByWorktree.get(worktreeId) ?? new Map<string, TabEvidence>()
    evidenceByWorktree.set(worktreeId, byTerminal)
    const evidence = byTerminal.get(terminalId) ?? {}
    byTerminal.set(terminalId, evidence)
    return evidence
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      evidenceFor(worktreeId, tab.id).rowPtyId ??= tab.ptyId
    }
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        evidenceFor(worktreeId, tab.entityId).unifiedHost ??= tab.executionHostId
      }
    }
  }
  const owned = new Map<string, Set<string>>()
  for (const [worktreeId, byTerminal] of evidenceByWorktree) {
    const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
    if (owner.kind !== 'resolved' || owner.environmentId !== null) {
      continue
    }
    // Any evidence naming another machine (a split pane's PTY, a pending tab's host stamp) makes the
    // whole tab that machine's, even when its workspace resolves here.
    const ids = new Set<string>()
    for (const [terminalId, { rowPtyId, unifiedHost }] of byTerminal) {
      const elsewhere =
        runsOnAnotherMachine(unifiedHost) ||
        collectPtyIdsForTab(state, terminalId, rowPtyId).some((ptyId) =>
          runsOnAnotherMachine(getPtyExecutionHost(ptyId))
        )
      if (!elsewhere) {
        ids.add(terminalId)
      }
    }
    owned.set(worktreeId, ids)
  }
  return owned
}

export function snapshotKillAllTerminalSurfaceIds(
  state: KillAllTerminalSurfaceState = useAppStore.getState()
): string[] {
  const targetIds = new Set<string>()
  for (const ids of ownedTerminalIdsByWorktree(state).values()) {
    ids.forEach((id) => targetIds.add(id))
  }
  return [...targetIds]
}

export function getKillAllTargetIndex(
  state: KillAllTerminalSurfaceState,
  targetIds: ReadonlySet<string>
): {
  ownerByTargetId: Map<string, string>
  terminalIdsByWorktree: Map<string, Set<string>>
} {
  const ownerByTargetId = new Map<string, string>()
  const terminalIdsByWorktree = new Map<string, Set<string>>()
  const owned = ownedTerminalIdsByWorktree(state)
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const ids = terminalIdsByWorktree.get(worktreeId) ?? new Set<string>()
    for (const tab of tabs) {
      ids.add(tab.id)
      if (
        targetIds.has(tab.id) &&
        !ownerByTargetId.has(tab.id) &&
        owned.get(worktreeId)?.has(tab.id) === true
      ) {
        ownerByTargetId.set(tab.id, worktreeId)
      }
    }
    terminalIdsByWorktree.set(worktreeId, ids)
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const ids = terminalIdsByWorktree.get(worktreeId) ?? new Set<string>()
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        ids.add(tab.entityId)
      }
      if (
        tab.contentType === 'terminal' &&
        targetIds.has(tab.entityId) &&
        !ownerByTargetId.has(tab.entityId) &&
        owned.get(worktreeId)?.has(tab.entityId) === true
      ) {
        ownerByTargetId.set(tab.entityId, worktreeId)
      }
    }
    terminalIdsByWorktree.set(worktreeId, ids)
  }
  return { ownerByTargetId, terminalIdsByWorktree }
}
