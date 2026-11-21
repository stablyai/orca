/** Merge local/paired-host samples and daemon sessions by project/workspace; unsampled metrics are null and paired rows are read-only. */

import type {
  MemorySnapshot,
  WorktreeMemory
} from '../../../../../../shared/diagnostics/process-stats-types'
import { parsePtySessionId } from '../../../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import type {
  MergeContext,
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import type { PtyListedSession as DaemonSession } from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { buildResourceSessionBindingIndex } from './resource-session-bindings'
import {
  resolveResourceFolderWorkspace,
  resolveResourceWorkspaceHost,
  stampedRuntimeHostId
} from './resource-workspace-host'
import {
  daemonSessionLiveTitleTabId,
  deriveWorktreeNameFromWorktreeId,
  resolveDaemonSessionLabel,
  resolveSnapshotSessionLabel
} from './resource-session-labels'
import {
  localSamplePlacement,
  pairedSamplePlacement,
  placementInputs,
  type SamplePlacement
} from './resource-sample-placement'
import {
  chatRowGroupsFor,
  isChatOnlySample,
  type ChatRowGroup,
  type ResourceMergeCache,
  type SampleChatRows
} from './resource-chat-row-groups'
import { applyProjectTotals } from './resource-project-totals'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export const UNATTRIBUTED_REPO_ID = '__unattributed__'
const LOCAL_SAMPLE = 'local'
const NO_RUNTIME_PANE_TITLES = { runtimePaneTitlesByTabId: {} }
function getUnattributedRepoName(t: Translate = translate): string {
  return t('auto.components.status.bar.mergeSnapshotAndSessions.unattributed', 'Unattributed')
}

export function mergeSnapshotAndSessions(
  snapshot: MemorySnapshot | null,
  daemonSessions: readonly DaemonSession[],
  ctx: MergeContext,
  t?: Translate,
  cache?: ResourceMergeCache
): UnifiedProjectGroup[] {
  const repos = new Map<string, UnifiedProjectGroup>()
  // Row positions for groups built in this merge.
  const rowIndexByRepo = new Map<string, Map<string, number>>()
  // Groups still shared with a cached sample; they are copied before anything changes them.
  const sharedRowIndexByRepo = new Map<string, ReadonlyMap<string, number>>()
  // Rows built in this merge; any other row is copied before it changes.
  const ownRows = new Set<UnifiedWorktreeRow>()
  const seenSessionIds = new Set<string>()
  // Include deferred wake hints so inactive restored sessions cannot become reclaimable orphans before their panes mount.
  const index = buildResourceSessionBindingIndex(ctx)
  const boundPtyIds = index.boundPtyIds
  // Only the daemon inventory supplies ownership and incarnation evidence.
  const daemonSessionsById = new Map(daemonSessions.map((session) => [session.id, session]))

  function ownGroup(repoId: string): UnifiedProjectGroup | undefined {
    const group = repos.get(repoId)
    const shared = sharedRowIndexByRepo.get(repoId)
    if (!group || !shared) {
      return group
    }
    const copy = { ...group, worktrees: [...group.worktrees] }
    repos.set(repoId, copy)
    rowIndexByRepo.set(repoId, new Map(shared))
    sharedRowIndexByRepo.delete(repoId)
    return copy
  }

  function ensureRepo(repoId: string, repoName: string): UnifiedProjectGroup {
    const existing = ownGroup(repoId)
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
    rowIndexByRepo.set(repoId, new Map())
    return next
  }

  function appendWorktreeRow(repo: UnifiedProjectGroup, row: UnifiedWorktreeRow): void {
    const rows = rowIndexByRepo.get(repo.repoId)!
    if (!rows.has(row.worktreeId)) {
      rows.set(row.worktreeId, repo.worktrees.length)
    }
    repo.worktrees.push(row)
    repo.hasRemoteChildren ||= row.isRemote
  }

  function addChatRowGroup({ group, rowIndexById }: ChatRowGroup): void {
    if (!repos.has(group.repoId)) {
      repos.set(group.repoId, group)
      sharedRowIndexByRepo.set(group.repoId, rowIndexById)
      return
    }
    const repo = ownGroup(group.repoId)!
    for (const row of group.worktrees) {
      appendWorktreeRow(repo, row)
    }
  }

  /** The workspace's row, made safe to change in this merge; undefined when it has none yet. */
  function rowToUpdate(repoId: string, worktreeId: string): UnifiedWorktreeRow | undefined {
    const position = (sharedRowIndexByRepo.get(repoId) ?? rowIndexByRepo.get(repoId))?.get(
      worktreeId
    )
    if (position === undefined) {
      return undefined
    }
    const repo = ownGroup(repoId)!
    const row = repo.worktrees[position]
    if (ownRows.has(row)) {
      return row
    }
    const copy = { ...row, sessions: [...row.sessions], browsers: [...row.browsers] }
    repo.worktrees[position] = copy
    ownRows.add(copy)
    return copy
  }

  function appendNewRow(row: UnifiedWorktreeRow): UnifiedWorktreeRow {
    ownRows.add(row)
    appendWorktreeRow(ensureRepo(row.repoId, row.repoName), row)
    return row
  }

  function ingestSampledWorktree(wt: WorktreeMemory, placement: SamplePlacement): void {
    const { readOnly, ...rowPlacement } = placement
    const sessions: UnifiedSessionRow[] = wt.sessions.map((s) => {
      seenSessionIds.add(s.sessionId)
      const tabId = index.ptyIdToTabId.get(s.sessionId) ?? null
      const daemonSession = daemonSessionsById.get(s.sessionId)
      return {
        sessionId: s.sessionId,
        incarnationId: daemonSession?.incarnationId,
        paneKey: s.paneKey,
        pid: s.pid,
        label: resolveSnapshotSessionLabel(s, placement.worktreeId, index, tabId),
        bound: ctx.workspaceSessionReady && boundPtyIds.has(s.sessionId),
        agentOwnership: daemonSession?.agentOwnership ?? 'unknown',
        tabId,
        cpu: s.cpu,
        memory: s.memory,
        hasLocalSamples: true,
        ...(readOnly ? { readOnly: true } : {})
      }
    })
    appendNewRow({
      ...rowPlacement,
      cpu: wt.cpu,
      memory: wt.memory,
      history: wt.history,
      hasLocalSamples: true,
      sessions,
      chats: wt.chats,
      browsers: []
    })
  }

  // ── Step 1: sampled workspaces. Chat-only rows come pre-grouped per sample; terminal rows are rebuilt.
  const nextSampleRows = new Map<string, SampleChatRows>()
  const inputs = placementInputs(ctx)
  const placeLocal = (wt: WorktreeMemory): SamplePlacement | null => localSamplePlacement(ctx, wt)
  if (snapshot) {
    for (const group of chatRowGroupsFor(
      cache,
      nextSampleRows,
      LOCAL_SAMPLE,
      snapshot.worktrees,
      inputs,
      placeLocal
    )) {
      addChatRowGroup(group)
    }
  }
  for (const host of ctx.runtimeHostResources ?? []) {
    const placePaired = (wt: WorktreeMemory): SamplePlacement =>
      pairedSamplePlacement(ctx, host, wt)
    for (const group of chatRowGroupsFor(
      cache,
      nextSampleRows,
      host.hostId,
      host.worktrees,
      [...inputs, host.hostLabel],
      placePaired
    )) {
      addChatRowGroup(group)
    }
  }
  if (cache) {
    cache.bySample = nextSampleRows
  }
  for (const wt of snapshot?.worktrees ?? []) {
    const placement = isChatOnlySample(wt) ? null : localSamplePlacement(ctx, wt)
    if (placement) {
      ingestSampledWorktree(wt, placement)
    }
  }
  for (const host of ctx.runtimeHostResources ?? []) {
    for (const wt of host.worktrees) {
      if (!isChatOnlySample(wt)) {
        ingestSampledWorktree(wt, pairedSamplePlacement(ctx, host, wt))
      }
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
      ? getUnattributedRepoName(t)
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
    if (runtimeHostId || stampedRuntimeHostId(ctx, finalWorktreeId)) {
      continue
    }

    const row =
      rowToUpdate(finalRepoId, finalWorktreeId) ??
      appendNewRow({
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
      })

    row.sessions.push({
      sessionId: session.id,
      incarnationId: session.incarnationId,
      paneKey: null,
      pid: 0,
      label: resolveDaemonSessionLabel(session, worktreeId, tabId, NO_RUNTIME_PANE_TITLES, index),
      liveTitleTabId: daemonSessionLiveTitleTabId(worktreeId, tabId, index),
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
    const row =
      rowToUpdate(worktree.repoId, worktreeId) ??
      appendNewRow({
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
      })
    row.browsers = browsers
  }

  // Shared groups carry their totals.
  for (const repo of repos.values()) {
    if (!sharedRowIndexByRepo.has(repo.repoId)) {
      applyProjectTotals(repo)
    }
  }

  return [...repos.values()]
}
