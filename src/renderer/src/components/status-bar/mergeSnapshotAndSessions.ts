/** Merge local/paired-host samples and daemon sessions by project/workspace; unsampled metrics are null and paired rows are read-only. */

import type { MemorySnapshot, WorktreeMemory } from '../../../../shared/process-stats-types'
import { parsePtySessionId } from '../../../../shared/pty-session-id-format'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type {
  DaemonSession,
  MergeContext,
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import { buildResourceSessionBindingIndex } from './resource-session-bindings'
import {
  resolveResourceFolderWorkspace,
  resolveResourceWorkspaceHost
} from './resource-workspace-host'
import {
  deriveWorktreeNameFromWorktreeId,
  resolveDaemonSessionLabel,
  resolveSnapshotSessionLabel
} from './resource-session-labels'

export const UNATTRIBUTED_REPO_ID = '__unattributed__'
export const UNATTRIBUTED_REPO_NAME = 'Unattributed'

export function mergeSnapshotAndSessions(
  snapshot: MemorySnapshot | null,
  daemonSessions: readonly DaemonSession[],
  ctx: MergeContext
): UnifiedProjectGroup[] {
  const repos = new Map<string, UnifiedProjectGroup>()
  const worktreeRowsByRepo = new Map<string, Map<string, UnifiedWorktreeRow>>()
  const seenSessionIds = new Set<string>()
  // Include deferred wake hints so inactive restored sessions cannot become reclaimable orphans before their panes mount.
  const index = buildResourceSessionBindingIndex(ctx)
  const boundPtyIds = index.boundPtyIds
  // Only the daemon inventory supplies ownership and incarnation evidence.
  const daemonSessionsById = new Map(daemonSessions.map((session) => [session.id, session]))

  function ensureRepo(repoId: string, repoName: string): UnifiedProjectGroup {
    const existing = repos.get(repoId)
    if (existing) {
      return existing
    }
    const next: UnifiedProjectGroup = {
      repoId,
      repoName,
      cpu: null,
      memory: null,
      hasRemoteChildren: false,
      worktrees: []
    }
    repos.set(repoId, next)
    worktreeRowsByRepo.set(repoId, new Map())
    return next
  }

  function findWorktreeRow(
    repo: UnifiedProjectGroup,
    worktreeId: string
  ): UnifiedWorktreeRow | undefined {
    return worktreeRowsByRepo.get(repo.repoId)?.get(worktreeId)
  }

  function appendWorktreeRow(repo: UnifiedProjectGroup, row: UnifiedWorktreeRow): void {
    repo.worktrees.push(row)
    repo.hasRemoteChildren ||= row.isRemote
    const rows = worktreeRowsByRepo.get(repo.repoId)!
    if (!rows.has(row.worktreeId)) {
      rows.set(row.worktreeId, row)
    }
  }

  function ingestSampledWorktree(
    wt: WorktreeMemory,
    row: Pick<UnifiedWorktreeRow, 'worktreeId' | 'repoId' | 'repoName' | 'isRemote'> & {
      worktreeName: string
      hostLabel?: string
      readOnly?: true
    }
  ): void {
    const repo = ensureRepo(row.repoId, row.repoName)
    const sessions: UnifiedSessionRow[] = wt.sessions.map((s) => {
      seenSessionIds.add(s.sessionId)
      const tabId = index.ptyIdToTabId.get(s.sessionId) ?? null
      const daemonSession = daemonSessionsById.get(s.sessionId)
      return {
        sessionId: s.sessionId,
        incarnationId: daemonSession?.incarnationId,
        paneKey: s.paneKey,
        pid: s.pid,
        label: resolveSnapshotSessionLabel(s, row.worktreeId, index),
        bound: ctx.workspaceSessionReady && boundPtyIds.has(s.sessionId),
        agentOwnership: daemonSession?.agentOwnership ?? 'unknown',
        tabId,
        cpu: s.cpu,
        memory: s.memory,
        hasLocalSamples: true,
        ...(row.readOnly ? { readOnly: true } : {})
      }
    })
    appendWorktreeRow(repo, {
      worktreeId: row.worktreeId,
      worktreeName: row.worktreeName,
      repoId: row.repoId,
      repoName: row.repoName,
      cpu: wt.cpu,
      memory: wt.memory,
      history: wt.history,
      hasLocalSamples: true,
      isRemote: row.isRemote,
      ...(row.hostLabel ? { hostLabel: row.hostLabel } : {}),
      sessions,
      browsers: []
    })
  }

  // ── Step 1: ingest snapshot worktrees as the local-truth foundation.
  if (snapshot) {
    for (const wt of snapshot.worktrees as readonly WorktreeMemory[]) {
      const worktree = resolveResourceFolderWorkspace(ctx, wt.worktreeId)
      const repoId = worktree?.repoId ?? wt.repoId
      const { isRemote, runtimeHostId } = resolveResourceWorkspaceHost(ctx, wt.worktreeId, repoId)
      // Reject local samples for runtime-hosted workspaces to prevent cross-host attribution.
      if (runtimeHostId) {
        continue
      }
      ingestSampledWorktree(wt, {
        worktreeId: wt.worktreeId,
        worktreeName: worktree?.displayName?.trim() || wt.worktreeName,
        repoId,
        repoName: (worktree && ctx.repoDisplayNameById.get(repoId)) || wt.repoName,
        isRemote
      })
    }
  }

  for (const host of ctx.runtimeHostResources ?? []) {
    for (const wt of host.worktrees) {
      const worktree = resolveResourceFolderWorkspace(ctx, wt.worktreeId)
      const repoId = worktree?.repoId ?? wt.repoId
      const owned =
        resolveResourceWorkspaceHost(ctx, wt.worktreeId, repoId).runtimeHostId === host.hostId
      // Keep foreign/unplaced server load host-qualified so same-ID workspaces elsewhere cannot absorb it.
      ingestSampledWorktree(wt, {
        worktreeId: owned ? wt.worktreeId : `${host.hostId}|${wt.worktreeId}`,
        worktreeName: (owned && worktree?.displayName?.trim()) || wt.worktreeName,
        repoId: owned ? repoId : `${host.hostId}|${wt.repoId}`,
        repoName: (owned && ctx.repoDisplayNameById.get(repoId)) || wt.repoName,
        isRemote: true,
        hostLabel: host.hostLabel,
        readOnly: true
      })
    }
  }

  for (const session of daemonSessions) {
    if (seenSessionIds.has(session.id)) {
      continue
    }
    seenSessionIds.add(session.id)

    const tabId = index.ptyIdToTabId.get(session.id) ?? null
    let worktreeId = tabId ? (index.tabIdToWorktreeId.get(tabId) ?? null) : null

    // Prefer daemon metadata; older publishers may only encode the workspace in the session id.
    if (!worktreeId) {
      worktreeId = session.worktreeId || parsePtySessionId(session.id).worktreeId
    }

    const isUnattributed = !worktreeId
    const finalWorktreeId = worktreeId ?? `${UNATTRIBUTED_REPO_ID}::${session.id}`
    const worktree = resolveResourceFolderWorkspace(ctx, finalWorktreeId)
    const finalRepoId = isUnattributed
      ? UNATTRIBUTED_REPO_ID
      : (worktree?.repoId ?? getRepoIdFromWorktreeId(finalWorktreeId))
    const finalRepoName = isUnattributed
      ? UNATTRIBUTED_REPO_NAME
      : ctx.repoDisplayNameById.get(finalRepoId) || finalRepoId
    const finalWorktreeName = isUnattributed
      ? session.title || session.id.slice(0, 12)
      : worktree?.displayName?.trim() || deriveWorktreeNameFromWorktreeId(finalWorktreeId)

    // Local/SSH daemon inventory cannot grant kill actions for paired-host PTYs.
    const { isRemote, runtimeHostId } = resolveResourceWorkspaceHost(
      ctx,
      finalWorktreeId,
      finalRepoId
    )
    if (runtimeHostId) {
      continue
    }

    const repo = ensureRepo(finalRepoId, finalRepoName)

    let row = findWorktreeRow(repo, finalWorktreeId)
    if (!row) {
      row = {
        worktreeId: finalWorktreeId,
        worktreeName: finalWorktreeName,
        repoId: finalRepoId,
        repoName: finalRepoName,
        cpu: null,
        memory: null,
        history: [],
        hasLocalSamples: false,
        isRemote,
        sessions: [],
        browsers: []
      }
      appendWorktreeRow(repo, row)
    }

    row.sessions.push({
      sessionId: session.id,
      incarnationId: session.incarnationId,
      paneKey: null,
      pid: 0,
      label: resolveDaemonSessionLabel(session, worktreeId, tabId, ctx, index),
      bound: ctx.workspaceSessionReady && boundPtyIds.has(session.id),
      agentOwnership: session.agentOwnership,
      tabId,
      cpu: null,
      memory: null,
      hasLocalSamples: false
    })
  }

  for (const [worktreeId, browsers] of Object.entries(ctx.browserTabsByWorktree ?? {})) {
    const worktree = ctx.worktreeById?.get(worktreeId)
    if (!worktree || browsers.length === 0) {
      continue
    }
    const repoName = ctx.repoDisplayNameById.get(worktree.repoId) || worktree.repoId
    const repo = ensureRepo(worktree.repoId, repoName)
    let row = findWorktreeRow(repo, worktreeId)
    if (!row) {
      row = {
        worktreeId,
        worktreeName: worktree.displayName,
        repoId: worktree.repoId,
        repoName,
        cpu: null,
        memory: null,
        history: [],
        hasLocalSamples: false,
        isRemote: resolveResourceWorkspaceHost(ctx, worktreeId, worktree.repoId).isRemote,
        sessions: [],
        browsers: []
      }
      appendWorktreeRow(repo, row)
    }
    row.browsers = browsers
  }

  // Only sampled rows contribute to project totals.
  for (const repo of repos.values()) {
    let cpuSum = 0
    let memSum = 0
    let anyLocal = false
    for (const wt of repo.worktrees) {
      if (wt.cpu !== null && wt.memory !== null) {
        cpuSum += wt.cpu
        memSum += wt.memory
        anyLocal = true
      }
    }
    repo.cpu = anyLocal ? cpuSum : null
    repo.memory = anyLocal ? memSum : null
  }

  return [...repos.values()]
}
