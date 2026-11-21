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
  UnifiedSessionRow
} from './resource-usage-merge-types'
import type { PtyListedSession as DaemonSession } from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { buildResourceSessionBindingIndex } from './resource-session-bindings'
import {
  resolveResourceFolderWorkspace,
  resolveResourceWorkspaceHost
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
  sampleRowsFor,
  type ResourceMergeCache,
  type SampleChatRows
} from './resource-chat-row-groups'
import { ProjectGroupAssembly } from './resource-project-group-assembly'
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
  const groups = new ProjectGroupAssembly()
  const seenSessionIds = new Set<string>()
  // Include deferred wake hints so inactive restored sessions cannot become reclaimable orphans before their panes mount.
  const index = buildResourceSessionBindingIndex(ctx)
  const boundPtyIds = index.boundPtyIds
  // Only the daemon inventory supplies ownership and incarnation evidence.
  const daemonSessionsById = new Map(daemonSessions.map((session) => [session.id, session]))

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
    groups.appendNewRow({
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
  const nextSamples = new Map<string, SampleChatRows>()
  const inputs = placementInputs(ctx)
  const local = snapshot
    ? sampleRowsFor(cache, nextSamples, LOCAL_SAMPLE, snapshot.worktrees, inputs, (wt) =>
        localSamplePlacement(ctx, wt)
      )
    : null
  if (cache) {
    cache.bySample = nextSamples
  }
  for (const part of local?.groups ?? []) {
    groups.addChatRowGroup(part)
  }
  const shownLocally = new Set<string>()
  // Local chat rows were added first, so a same-id row in the project is this machine's.
  const isShownLocally = (worktreeId: string, repoId: string): boolean =>
    shownLocally.has(worktreeId) || groups.hasRow(repoId, worktreeId)
  for (const wt of local?.terminalSamples ?? []) {
    const placement = localSamplePlacement(ctx, wt)
    if (placement) {
      shownLocally.add(placement.worktreeId)
      ingestSampledWorktree(wt, placement)
    }
  }
  // This machine's live terminals come before paired samples, so a same-id paired sample is host-qualified.
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
    if (runtimeHostId) {
      continue
    }
    shownLocally.add(finalWorktreeId)

    const row =
      groups.rowToUpdate(finalRepoId, finalWorktreeId) ??
      groups.appendNewRow({
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

  // Paired machines send terminals only, so their samples go straight to placement.
  for (const host of ctx.runtimeHostResources ?? []) {
    for (const wt of host.worktrees) {
      ingestSampledWorktree(wt, pairedSamplePlacement(ctx, host, wt, isShownLocally))
    }
  }

  for (const [worktreeId, browsers] of Object.entries(ctx.browserTabsByWorktree ?? {})) {
    const worktree = ctx.worktreeById?.get(worktreeId)
    if (!worktree || browsers.length === 0) {
      continue
    }
    const repoName = ctx.repoDisplayNameById.get(worktree.repoId) || worktree.repoId
    const row =
      groups.rowToUpdate(worktree.repoId, worktreeId) ??
      groups.appendNewRow({
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

  return groups.finish()
}
