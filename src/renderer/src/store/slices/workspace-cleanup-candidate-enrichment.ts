import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  applyWorkspaceCleanupPolicy,
  shouldHideWorkspaceCleanupCandidate,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissal
} from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateHostId,
  getWorkspaceCleanupCandidateIdentity
} from '../../../../shared/workspace-cleanup-host-identity'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'
import {
  buildWorkspaceCleanupAgentStatusIndex,
  hasFreshIndexedLiveAgent,
  hasWorkingTitleAgent,
  probeTerminalLiveness,
  shouldPreserveCleanupInspection
} from './workspace-cleanup-local-evidence'

export type WorkspaceCleanupEnrichOptions = {
  applyDismissals?: boolean
}

export type WorkspaceCleanupEnrichmentCacheEntry = {
  candidateRef: WorkspaceCleanupCandidate
  inputSignature: string
  localSignature: string
  candidate: WorkspaceCleanupCandidate
}

type WorkspaceCleanupEnrichmentProjection = {
  openFilesByWorktreeId: Map<string, AppState['openFiles']>
  retainedDoneAgentPaneKeysByWorktreeId: Map<string, string[]>
  agentStatusesByTabId: Map<string, AgentStatusEntry[]>
}

export const WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY = 8
const RECENT_VISIBLE_CONTEXT_MS = 24 * 60 * 60 * 1000

export async function enrichWorkspaceCleanupCandidates(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  options: WorkspaceCleanupEnrichOptions = {}
): Promise<WorkspaceCleanupCandidate[]> {
  const projection = buildWorkspaceCleanupEnrichmentProjection(candidates, state)
  return mapWithConcurrency(candidates, WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY, (candidate) =>
    enrichWorkspaceCleanupCandidate(candidate, state, projection, options)
  )
}

export async function enrichWorkspaceCleanupCandidatesWithCache(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  cache: Map<string, WorkspaceCleanupEnrichmentCacheEntry>,
  options: WorkspaceCleanupEnrichOptions & { localStateUnchanged?: boolean } = {}
): Promise<WorkspaceCleanupCandidate[]> {
  const projection = buildWorkspaceCleanupEnrichmentProjection(candidates, state)
  return mapWithConcurrency(
    candidates,
    WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY,
    async (candidate) => {
      const identity = getWorkspaceCleanupCandidateIdentity(candidate)
      const cached = cache.get(identity)
      if (options.localStateUnchanged === true && cached?.candidateRef === candidate) {
        return cached.candidate
      }
      const inputSignature = getWorkspaceCleanupCandidateInputSignature(candidate)
      const localSignature = getWorkspaceCleanupLocalStateSignature(
        candidate,
        state,
        projection,
        options
      )
      if (cached?.inputSignature === inputSignature && cached.localSignature === localSignature) {
        cached.candidateRef = candidate
        return cached.candidate
      }

      const enriched = await enrichWorkspaceCleanupCandidate(candidate, state, projection, options)
      cache.set(identity, {
        candidateRef: candidate,
        inputSignature,
        localSignature,
        candidate: enriched
      })
      return enriched
    }
  )
}

function buildWorkspaceCleanupEnrichmentProjection(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState
): WorkspaceCleanupEnrichmentProjection {
  const worktreeIds = new Set(candidates.map((candidate) => candidate.worktreeId))
  const tabIds = new Set<string>()
  for (const worktreeId of worktreeIds) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      tabIds.add(tab.id)
    }
  }

  const openFilesByWorktreeId = new Map<string, AppState['openFiles']>()
  for (const file of state.openFiles) {
    if (!worktreeIds.has(file.worktreeId)) {
      continue
    }
    const files = openFilesByWorktreeId.get(file.worktreeId) ?? []
    files.push(file)
    openFilesByWorktreeId.set(file.worktreeId, files)
  }

  const retainedDoneAgentPaneKeysByWorktreeId = new Map<string, string[]>()
  for (const [paneKey, retained] of Object.entries(state.retainedAgentsByPaneKey)) {
    if (!worktreeIds.has(retained.worktreeId) || retained.entry.state !== 'done') {
      continue
    }
    const paneKeys = retainedDoneAgentPaneKeysByWorktreeId.get(retained.worktreeId) ?? []
    paneKeys.push(paneKey)
    retainedDoneAgentPaneKeysByWorktreeId.set(retained.worktreeId, paneKeys)
  }

  const agentStatusesByTabId = buildWorkspaceCleanupAgentStatusIndex(state, tabIds)

  return {
    openFilesByWorktreeId,
    retainedDoneAgentPaneKeysByWorktreeId,
    agentStatusesByTabId
  }
}

function getWorkspaceCleanupCandidateInputSignature(candidate: WorkspaceCleanupCandidate): string {
  return JSON.stringify({
    fingerprint: candidate.fingerprint,
    blockers: candidate.blockers,
    reasons: candidate.reasons,
    git: candidate.git,
    lastActivityAt: candidate.lastActivityAt,
    createdAt: candidate.createdAt,
    path: candidate.path,
    branch: candidate.branch
  })
}

function getWorkspaceCleanupLocalStateSignature(
  candidate: WorkspaceCleanupCandidate,
  state: AppState,
  projection: WorkspaceCleanupEnrichmentProjection,
  options: WorkspaceCleanupEnrichOptions
): string {
  const { worktreeId } = candidate
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const tabIds = tabs.map((tab) => tab.id)
  const tabIdSet = new Set(tabIds)
  const openFiles = (projection.openFilesByWorktreeId.get(worktreeId) ?? []).map((file) => ({
    id: file.id,
    isDirty: file.isDirty,
    hasDraft: state.editorDrafts[file.id] !== undefined
  }))
  const retainedDoneAgentPaneKeys = [
    ...(projection.retainedDoneAgentPaneKeysByWorktreeId.get(worktreeId) ?? [])
  ].sort()
  const agentStatuses = [...tabIdSet]
    .flatMap((tabId) => projection.agentStatusesByTabId.get(tabId) ?? [])
    .map((entry) => ({
      paneKey: entry.paneKey,
      state: entry.state,
      updatedAt: entry.updatedAt
    }))
    .sort((a, b) => a.paneKey.localeCompare(b.paneKey))
  const ptyIdsByTabId = Object.fromEntries(
    tabIds.map((tabId) => [tabId, state.ptyIdsByTabId[tabId] ?? []])
  )
  const runtimePaneTitlesByTabId = Object.fromEntries(
    tabIds.map((tabId) => [tabId, state.runtimePaneTitlesByTabId[tabId] ?? {}])
  )
  const terminalLayoutsByTabId = Object.fromEntries(
    tabIds.map((tabId) => [tabId, state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {}])
  )
  const dismissal =
    options.applyDismissals === false
      ? null
      : (getWorkspaceCleanupDismissal(candidate, state.workspaceCleanupDismissals) ?? null)

  return JSON.stringify({
    active: state.activeWorktreeId === worktreeId,
    tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title })),
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    terminalLayoutsByTabId,
    openFiles,
    browserTabCount: (state.browserTabsByWorktree[worktreeId] ?? []).length,
    retainedDoneAgentPaneKeys,
    agentStatuses,
    lastVisitedAt:
      getWorktreeVisitTimestamp(state.lastVisitedAtByWorktreeId, {
        id: worktreeId,
        hostId: getWorkspaceCleanupCandidateHostId(candidate)
      }) ?? 0,
    viewed: state.workspaceCleanupViewedCandidates[worktreeId] ?? null,
    dismissal
  })
}

async function enrichWorkspaceCleanupCandidate(
  candidate: WorkspaceCleanupCandidate,
  state: AppState,
  projection: WorkspaceCleanupEnrichmentProjection,
  options: WorkspaceCleanupEnrichOptions
): Promise<WorkspaceCleanupCandidate> {
  const tabs = state.tabsByWorktree[candidate.worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const openFiles = projection.openFilesByWorktreeId.get(candidate.worktreeId) ?? []
  const dirtyEditorBuffers = openFiles.filter(
    (file) => file.isDirty || state.editorDrafts[file.id] !== undefined
  )
  const cleanEditorTabCount = openFiles.length - dirtyEditorBuffers.length
  const browserTabCount = (state.browserTabsByWorktree[candidate.worktreeId] ?? []).length
  const retainedDoneAgentCount =
    projection.retainedDoneAgentPaneKeysByWorktreeId.get(candidate.worktreeId)?.length ?? 0
  const blockers = candidate.blockers.filter((blocker) => blocker !== 'dismissed')
  const preserveCleanupInspection = shouldPreserveCleanupInspection(candidate, state)

  if (state.activeWorktreeId === candidate.worktreeId) {
    blockers.push('active-workspace')
  }
  if (dirtyEditorBuffers.length > 0) {
    blockers.push('dirty-editor-buffer')
  }
  if (hasFreshIndexedLiveAgent(projection.agentStatusesByTabId, tabIds)) {
    blockers.push('live-agent')
  }
  if (hasWorkingTitleAgent(state, tabs)) {
    blockers.push('live-agent')
  }

  const terminalProbe = await probeTerminalLiveness(state, tabs)
  if (terminalProbe === 'running') {
    blockers.push('running-terminal')
  } else if (terminalProbe === 'unknown') {
    blockers.push('terminal-liveness-unknown')
  }

  const lastVisitedAt =
    getWorktreeVisitTimestamp(state.lastVisitedAtByWorktreeId, {
      id: candidate.worktreeId,
      hostId: getWorkspaceCleanupCandidateHostId(candidate)
    }) ?? 0
  const hasVisibleContext = cleanEditorTabCount > 0 || browserTabCount > 0
  if (
    hasVisibleContext &&
    !preserveCleanupInspection &&
    lastVisitedAt > 0 &&
    Date.now() - lastVisitedAt <= RECENT_VISIBLE_CONTEXT_MS
  ) {
    blockers.push('recent-visible-context')
  }

  const enriched = applyWorkspaceCleanupPolicy({
    ...candidate,
    blockers: [...new Set(blockers)],
    localContext: {
      ...candidate.localContext,
      terminalTabCount: tabs.length,
      cleanEditorTabCount,
      browserTabCount,
      retainedDoneAgentCount
    }
  })

  return options.applyDismissals === false
    ? enriched
    : applyWorkspaceCleanupDismissal(enriched, state.workspaceCleanupDismissals)
}

export function applyWorkspaceCleanupDismissal(
  candidate: WorkspaceCleanupCandidate,
  dismissals: Record<string, WorkspaceCleanupDismissal>
): WorkspaceCleanupCandidate {
  if (
    !shouldHideWorkspaceCleanupCandidate(
      candidate,
      getWorkspaceCleanupDismissal(candidate, dismissals)
    )
  ) {
    return candidate
  }
  return applyWorkspaceCleanupPolicy({
    ...candidate,
    blockers: [...new Set<WorkspaceCleanupBlocker>([...candidate.blockers, 'dismissed'])]
  })
}

function getWorkspaceCleanupDismissal(
  candidate: WorkspaceCleanupCandidate,
  dismissals: Record<string, WorkspaceCleanupDismissal>
): WorkspaceCleanupDismissal | undefined {
  return (
    dismissals[getWorkspaceCleanupCandidateIdentity(candidate)] ?? dismissals[candidate.worktreeId]
  )
}
