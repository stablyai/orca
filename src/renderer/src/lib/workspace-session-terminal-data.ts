import { parseExecutionHostId } from '../../../shared/execution-host'
import { normalizeSshConnectionId, parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import {
  normalizeWorktreeLookupId,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'

export function buildTerminalSessionData(
  snapshot: WorkspaceSessionSnapshot
): Pick<WorkspaceSessionState, 'activeWorktreeIdsOnShutdown' | 'remoteSessionIdsByTabId'> {
  const tabsByWorktree = snapshot.tabsByWorktree

  // Why: use ptyIdsByTabId (live PTYs), not tab.ptyId, which sleep preserves as a wake hint and would revive slept worktrees as active.
  const ptyIdsByTabId = snapshot.ptyIdsByTabId
  const hasLivePty = (tabId: string): boolean => (ptyIdsByTabId[tabId]?.length ?? 0) > 0

  // Why: relay reconnect keeps lastKnown but clears tab.ptyId; the !tab.ptyId guard excludes slept tabs (which keep ptyId as a wake hint).
  const lastKnown = snapshot.lastKnownRelayPtyIdByTabId
  const hasReconnectableSession = (tab: { id: string; ptyId: string | null }): boolean =>
    hasLivePty(tab.id) || (!tab.ptyId && Boolean(lastKnown[tab.id]))

  const activeWorktreeIdsOnShutdown = Object.entries(tabsByWorktree)
    .filter(([, tabs]) => tabs.some(hasReconnectableSession))
    .map(([worktreeId]) => worktreeId)

  // Why: derive here to avoid a fragile sync IPC round-trip during beforeunload (Chromium can drop it under shutdown pressure).
  // Why: the owner indexes are cached by immutable catalog snapshots, so large workspaces do not rescan every repo/worktree per tab.
  const remoteSessionIdsByTabId: Record<string, string> = {}
  for (const [workspaceSessionKey, tabs] of Object.entries(tabsByWorktree)) {
    const rawWorktreeId = normalizeWorktreeLookupId(workspaceSessionKey)
    if (rawWorktreeId === null) {
      continue
    }
    const worktreeResolution = resolveIndexedWorktreeOwner(snapshot.worktreesByRepo, rawWorktreeId)
    // A bare id published by two hosts is not enough to identify which relay
    // owns the persisted PTY. Keep the session out of the durable remote map
    // until a host-qualified catalog row is available.
    if (worktreeResolution.kind === 'ambiguous') {
      continue
    }
    // SSH worktrees can be absent from the cold-start catalog while their
    // canonical session key still carries the repo id needed to classify the
    // persisted relay session.
    const repoId =
      worktreeResolution.kind === 'resolved'
        ? worktreeResolution.owner.repoId
        : getRepoIdFromWorktreeId(rawWorktreeId)
    const repoResolution = resolveIndexedRepoOwner(snapshot.repos, repoId)
    if (repoResolution.kind !== 'resolved') {
      continue
    }
    const repoConnectionId = repoResolution.owner.connectionId?.trim() || null
    const repoHost = parseExecutionHostId(repoResolution.owner.executionHostId)
    const repoSshTargetId = repoConnectionId
      ? normalizeSshConnectionId(repoConnectionId)
      : repoHost?.kind === 'ssh'
        ? repoHost.targetId
        : null
    // A loaded worktree row can carry the physical SSH target even when the
    // repo row is projected through a paired runtime. Contradictory target
    // stamps are not safe evidence for a durable relay session.
    const worktreeHost =
      worktreeResolution.kind === 'resolved'
        ? parseExecutionHostId(worktreeResolution.owner.hostId)
        : null
    const worktreeSshTargetId = worktreeHost?.kind === 'ssh' ? worktreeHost.targetId : null
    if (worktreeSshTargetId && repoSshTargetId && worktreeSshTargetId !== repoSshTargetId) {
      continue
    }
    const normalizedRepoTargetId = worktreeSshTargetId ?? repoSshTargetId
    if (!normalizedRepoTargetId) {
      continue
    }
    for (const tab of tabs) {
      if (!hasReconnectableSession(tab)) {
        continue
      }
      const sessionId = tab.ptyId || lastKnown[tab.id]
      if (sessionId) {
        const parsedSshSession = parseAppSshPtyId(sessionId)
        // Explicit app SSH ids name their target. Never advertise one under a
        // different repo/worktree owner (or an unparseable ssh-shaped id).
        if (
          sessionId.startsWith('ssh:') &&
          (!parsedSshSession || parsedSshSession.connectionId !== normalizedRepoTargetId)
        ) {
          continue
        }
        remoteSessionIdsByTabId[tab.id] = sessionId
      }
    }
  }

  return {
    activeWorktreeIdsOnShutdown,
    remoteSessionIdsByTabId:
      Object.keys(remoteSessionIdsByTabId).length > 0 ? remoteSessionIdsByTabId : undefined
  }
}
