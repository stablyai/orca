/* eslint-disable max-lines -- Why: cleanup scan persistence, renderer safety
   enrichment, dismissals, and destructive preflight/delete orchestration share
   one store state contract. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  applyWorkspaceCleanupPolicy,
  canQueueWorkspaceCleanupCandidate,
  canSelectWorkspaceCleanupCandidate,
  shouldForceWorkspaceCleanupRemoval,
  shouldHideWorkspaceCleanupCandidate,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissal,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanProgress,
  type WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import { classifyTitleActivity, isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { translate } from '@/i18n/i18n'

export type WorkspaceCleanupFailure = {
  worktreeId: string
  displayName: string
  message: string
}

export type WorkspaceCleanupRemoveResult = {
  removedIds: string[]
  failures: WorkspaceCleanupFailure[]
}

export type WorkspaceCleanupRemoveOptions = {
  // Why: rows are removed long after the confirm click; the confirm-time
  // candidate records how much git risk the user actually approved.
  approvedCandidates?: readonly WorkspaceCleanupCandidate[]
}

type WorkspaceCleanupViewedCandidate = {
  viewedAt: number
  fingerprint: string
  wasSuggested: boolean
}

export type WorkspaceCleanupSlice = {
  workspaceCleanupScan: WorkspaceCleanupScanResult | null
  workspaceCleanupProgress: WorkspaceCleanupScanProgress | null
  workspaceCleanupLoading: boolean
  workspaceCleanupError: string | null
  workspaceCleanupDismissals: Record<string, WorkspaceCleanupDismissal>
  workspaceCleanupViewedCandidates: Record<string, WorkspaceCleanupViewedCandidate>
  scanWorkspaceCleanup: (args?: WorkspaceCleanupScanArgs) => Promise<WorkspaceCleanupScanResult>
  markWorkspaceCleanupCandidateViewed: (candidate: WorkspaceCleanupCandidate) => void
  dismissWorkspaceCleanupCandidates: (
    candidates: readonly WorkspaceCleanupCandidate[]
  ) => Promise<void>
  resetWorkspaceCleanupDismissals: () => Promise<void>
  removeWorkspaceCleanupCandidates: (
    worktreeIds: readonly string[],
    options?: WorkspaceCleanupRemoveOptions
  ) => Promise<WorkspaceCleanupRemoveResult>
}

type EnrichOptions = {
  applyDismissals?: boolean
}

type WorkspaceCleanupEnrichmentCacheEntry = {
  inputSignature: string
  localSignature: string
  candidate: WorkspaceCleanupCandidate
}

const RECENT_VISIBLE_CONTEXT_MS = 24 * 60 * 60 * 1000
const VIEWED_FROM_CLEANUP_MS = 2 * 60 * 60 * 1000
const WORKSPACE_CLEANUP_PREFLIGHT_CONCURRENCY = 4
// Why: dirty-files/unpushed-commits are concrete known work at risk; unknown-base
// and git-status-error only mean "couldn't verify". A row approved while
// unverifiable must still fail if real work becomes visible before removal.
const WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS = ['dirty-files', 'unpushed-commits'] as const

let inFlightWorkspaceCleanupScan: {
  key: string
  promise: Promise<WorkspaceCleanupScanResult>
} | null = null
let latestWorkspaceCleanupScanToken = 0
let finalizedWorkspaceCleanupScanToken = 0
let workspaceCleanupProgressQueue: {
  scanToken: number
  promise: Promise<void>
} | null = null
let workspaceCleanupEnrichmentCache: {
  scanToken: number
  entries: Map<string, WorkspaceCleanupEnrichmentCacheEntry>
} | null = null
// Why: cleanup progress can append thousands of rows; keep one scan-local
// index so each streamed row does not rebuild a map of every previous row.
let workspaceCleanupProgressCandidateIndex: {
  scanToken: number
  scanId: string
  candidates: WorkspaceCleanupCandidate[]
  indexesByWorktreeId: Map<string, number>
} | null = null

const SHELL_PROCESS_NAMES = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'fish',
  'nu',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sh',
  'zsh'
])

const AGENT_PROCESS_NAMES = new Set([
  'aider',
  'amp',
  'agy',
  'claude',
  'claude-code',
  'codex',
  'crush',
  'droid',
  'gemini',
  'gemini-cli',
  'goose',
  'opencode'
])

export const createWorkspaceCleanupSlice: StateCreator<AppState, [], [], WorkspaceCleanupSlice> = (
  set,
  get
) => ({
  workspaceCleanupScan: null,
  workspaceCleanupProgress: null,
  workspaceCleanupLoading: false,
  workspaceCleanupError: null,
  workspaceCleanupDismissals: {},
  workspaceCleanupViewedCandidates: {},

  scanWorkspaceCleanup: async (args) => {
    if (args?.worktreeId !== undefined) {
      const scan = await window.api.workspaceCleanup.scan(args)
      const enriched = await enrichWorkspaceCleanupCandidates(scan.candidates, get(), {
        applyDismissals: false
      })
      return { ...scan, candidates: enriched }
    }

    const scanArgs = {
      ...args,
      skipGitWorktreeIds: [
        ...new Set([
          ...(args?.skipGitWorktreeIds ?? []),
          ...getInitialWorkspaceCleanupGitDeferrals(get())
        ])
      ]
    }
    const scanKey = getWorkspaceCleanupScanKey(scanArgs)

    if (inFlightWorkspaceCleanupScan?.key === scanKey) {
      set({ workspaceCleanupLoading: true, workspaceCleanupError: null })
      try {
        return await inFlightWorkspaceCleanupScan.promise
      } finally {
        if (!inFlightWorkspaceCleanupScan) {
          set({ workspaceCleanupLoading: false })
        }
      }
    }

    set({
      workspaceCleanupLoading: true,
      workspaceCleanupProgress: null,
      workspaceCleanupError: null
    })
    const scanToken = ++latestWorkspaceCleanupScanToken
    finalizedWorkspaceCleanupScanToken = 0
    workspaceCleanupProgressQueue = null
    workspaceCleanupEnrichmentCache = { scanToken, entries: new Map() }
    workspaceCleanupProgressCandidateIndex = null
    const promise = (async () => {
      const scan = await window.api.workspaceCleanup.scan(scanArgs, (progress) => {
        enqueueWorkspaceCleanupProgress(progress, scanToken, get, set)
      })
      const enriched = await enrichWorkspaceCleanupCandidatesForScan(
        scan.candidates,
        get(),
        scanToken
      )
      const result = { ...scan, candidates: enriched }
      if (scanToken === latestWorkspaceCleanupScanToken) {
        finalizedWorkspaceCleanupScanToken = scanToken
        workspaceCleanupEnrichmentCache = null
        workspaceCleanupProgressCandidateIndex = null
        set({
          workspaceCleanupScan: result,
          workspaceCleanupProgress: {
            scanId: get().workspaceCleanupProgress?.scanId ?? scanArgs.scanId ?? '',
            scannedAt: result.scannedAt,
            scannedWorktreeCount: result.candidates.length,
            totalWorktreeCount: result.candidates.length,
            candidates: result.candidates,
            errors: result.errors
          },
          workspaceCleanupLoading: false
        })
      }
      return result
    })()
    inFlightWorkspaceCleanupScan = { key: scanKey, promise }

    try {
      return await promise
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (scanToken === latestWorkspaceCleanupScanToken) {
        set({ workspaceCleanupError: message, workspaceCleanupLoading: false })
      }
      throw error
    } finally {
      if (inFlightWorkspaceCleanupScan?.promise === promise) {
        inFlightWorkspaceCleanupScan = null
      }
    }
  },

  markWorkspaceCleanupCandidateViewed: (candidate) => {
    set((state) => ({
      workspaceCleanupViewedCandidates: {
        ...state.workspaceCleanupViewedCandidates,
        [candidate.worktreeId]: {
          viewedAt: Date.now(),
          fingerprint: candidate.fingerprint,
          wasSuggested: candidate.tier === 'ready' && canSelectWorkspaceCleanupCandidate(candidate)
        }
      }
    }))
  },

  dismissWorkspaceCleanupCandidates: async (candidates) => {
    const now = Date.now()
    const dismissals = candidates.map((candidate) => ({
      worktreeId: candidate.worktreeId,
      dismissedAt: now,
      fingerprint: candidate.fingerprint,
      classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION
    }))

    set((state) => {
      const nextDismissals = { ...state.workspaceCleanupDismissals }
      for (const dismissal of dismissals) {
        nextDismissals[dismissal.worktreeId] = dismissal
      }
      const nextScan = state.workspaceCleanupScan
        ? {
            ...state.workspaceCleanupScan,
            candidates: state.workspaceCleanupScan.candidates.map((candidate) =>
              applyDismissal(candidate, nextDismissals)
            )
          }
        : state.workspaceCleanupScan
      return {
        workspaceCleanupDismissals: nextDismissals,
        workspaceCleanupScan: nextScan
      }
    })

    await window.api.workspaceCleanup.dismiss({ dismissals })
  },

  resetWorkspaceCleanupDismissals: async () => {
    set((state) => ({
      workspaceCleanupDismissals: {},
      workspaceCleanupScan: state.workspaceCleanupScan
        ? {
            ...state.workspaceCleanupScan,
            candidates: state.workspaceCleanupScan.candidates.map((candidate) =>
              applyWorkspaceCleanupPolicy({
                ...candidate,
                blockers: candidate.blockers.filter((blocker) => blocker !== 'dismissed')
              })
            )
          }
        : state.workspaceCleanupScan
    }))
    await window.api.workspaceCleanup.clearDismissals()
  },

  removeWorkspaceCleanupCandidates: async (worktreeIds, options) => {
    const removedIds: string[] = []
    const failures: WorkspaceCleanupFailure[] = []
    const approvedCandidatesByWorktreeId = new Map(
      (options?.approvedCandidates ?? []).map((candidate) => [candidate.worktreeId, candidate])
    )

    const preflights = await mapWithConcurrency(
      worktreeIds,
      WORKSPACE_CLEANUP_PREFLIGHT_CONCURRENCY,
      (worktreeId) =>
        preflightWorkspaceCleanupCandidate(
          worktreeId,
          get,
          approvedCandidatesByWorktreeId.get(worktreeId)
        )
    )
    const candidatesToRemove: WorkspaceCleanupCandidate[] = []

    for (const preflight of preflights) {
      if (!preflight.ok) {
        failures.push(preflight.failure)
        continue
      }
      candidatesToRemove.push(preflight.candidate)
    }

    // Why: nested workspaces can belong to different repos; parent removal must
    // not race child cleanup hooks, PTY teardown, or metadata deletion.
    for (const candidate of [...candidatesToRemove].sort((a, b) => b.path.length - a.path.length)) {
      const result = await get().removeWorktree(
        candidate.worktreeId,
        shouldForceWorkspaceCleanupRemoval(candidate),
        // Why: cleanup reports outcomes in its own summary toasts; per-row
        // preserved-branch warnings would stack one toast per removed row.
        { suppressPreservedBranchToast: true }
      )
      if (result.ok) {
        removedIds.push(candidate.worktreeId)
      } else {
        failures.push({
          worktreeId: candidate.worktreeId,
          displayName: candidate.displayName,
          message: result.error
        })
      }
    }

    if (removedIds.length > 0) {
      invalidateWorkspaceCleanupScanProgress()
      const removedIdSet = new Set(removedIds)
      set((state) => ({
        workspaceCleanupLoading: false,
        workspaceCleanupScan: state.workspaceCleanupScan
          ? {
              ...state.workspaceCleanupScan,
              candidates: state.workspaceCleanupScan.candidates.filter(
                (candidate) => !removedIdSet.has(candidate.worktreeId)
              )
            }
          : state.workspaceCleanupScan
      }))
    }

    return { removedIds, failures }
  }
})

function getWorkspaceCleanupScanKey(args: WorkspaceCleanupScanArgs): string {
  return JSON.stringify({
    skipGitWorktreeIds: [...new Set(args.skipGitWorktreeIds ?? [])].sort()
  })
}

function invalidateWorkspaceCleanupScanProgress(): void {
  latestWorkspaceCleanupScanToken += 1
  finalizedWorkspaceCleanupScanToken = 0
  inFlightWorkspaceCleanupScan = null
  workspaceCleanupProgressQueue = null
  workspaceCleanupEnrichmentCache = null
  workspaceCleanupProgressCandidateIndex = null
}

function enqueueWorkspaceCleanupProgress(
  progress: WorkspaceCleanupScanProgress,
  scanToken: number,
  getState: () => AppState,
  setState: (
    partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
    replace?: false
  ) => void
): void {
  if (
    scanToken !== latestWorkspaceCleanupScanToken ||
    scanToken === finalizedWorkspaceCleanupScanToken
  ) {
    return
  }
  const previous =
    workspaceCleanupProgressQueue?.scanToken === scanToken
      ? workspaceCleanupProgressQueue.promise
      : Promise.resolve()
  const promise = previous
    .catch(() => undefined)
    .then(() => applyWorkspaceCleanupProgress(progress, scanToken, getState, setState))
    .catch((error: unknown) => {
      console.error('Workspace cleanup progress update failed', error)
    })
  workspaceCleanupProgressQueue = { scanToken, promise }
}

async function applyWorkspaceCleanupProgress(
  progress: WorkspaceCleanupScanProgress,
  scanToken: number,
  getState: () => AppState,
  setState: (
    partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
    replace?: false
  ) => void
): Promise<void> {
  if (
    scanToken !== latestWorkspaceCleanupScanToken ||
    scanToken === finalizedWorkspaceCleanupScanToken
  ) {
    return
  }
  const state = getState()
  const previousCandidates =
    progress.candidateMode === 'append' &&
    state.workspaceCleanupProgress?.scanId === progress.scanId
      ? state.workspaceCleanupProgress.candidates
      : []
  const enrichedProgressCandidates = await enrichWorkspaceCleanupCandidatesForScan(
    progress.candidates,
    state,
    scanToken
  )
  if (
    scanToken !== latestWorkspaceCleanupScanToken ||
    scanToken === finalizedWorkspaceCleanupScanToken
  ) {
    return
  }
  const candidates = mergeWorkspaceCleanupProgressCandidates({
    previousCandidates,
    nextCandidates: enrichedProgressCandidates,
    progress,
    scanToken
  })
  if (
    scanToken !== latestWorkspaceCleanupScanToken ||
    scanToken === finalizedWorkspaceCleanupScanToken
  ) {
    workspaceCleanupProgressCandidateIndex = null
    return
  }
  setState((state) => {
    if (
      state.workspaceCleanupProgress?.scanId === progress.scanId &&
      state.workspaceCleanupProgress.scannedWorktreeCount > progress.scannedWorktreeCount
    ) {
      return {}
    }
    return {
      workspaceCleanupScan: {
        scannedAt: progress.scannedAt,
        candidates,
        errors: progress.errors
      },
      workspaceCleanupProgress: { ...progress, candidates }
    }
  })
}

async function enrichWorkspaceCleanupCandidatesForScan(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  scanToken: number
): Promise<WorkspaceCleanupCandidate[]> {
  if (workspaceCleanupEnrichmentCache?.scanToken !== scanToken) {
    workspaceCleanupEnrichmentCache = { scanToken, entries: new Map() }
  }
  return enrichWorkspaceCleanupCandidatesWithCache(
    candidates,
    state,
    workspaceCleanupEnrichmentCache.entries
  )
}

function mergeWorkspaceCleanupProgressCandidates({
  previousCandidates,
  nextCandidates,
  progress,
  scanToken
}: {
  previousCandidates: readonly WorkspaceCleanupCandidate[]
  nextCandidates: readonly WorkspaceCleanupCandidate[]
  progress: WorkspaceCleanupScanProgress
  scanToken: number
}): WorkspaceCleanupCandidate[] {
  if (progress.candidateMode !== 'append') {
    workspaceCleanupProgressCandidateIndex = null
    return [...nextCandidates]
  }

  if (nextCandidates.length === 0) {
    return previousCandidates as WorkspaceCleanupCandidate[]
  }

  const indexCache = getWorkspaceCleanupProgressCandidateIndex(
    previousCandidates,
    progress.scanId,
    scanToken
  )
  const merged = [...indexCache.candidates]
  for (const candidate of nextCandidates) {
    const existingIndex = indexCache.indexesByWorktreeId.get(candidate.worktreeId)
    if (existingIndex === undefined) {
      indexCache.indexesByWorktreeId.set(candidate.worktreeId, merged.length)
      merged.push(candidate)
      continue
    }
    merged[existingIndex] = candidate
  }
  workspaceCleanupProgressCandidateIndex = {
    scanToken,
    scanId: progress.scanId,
    candidates: merged,
    indexesByWorktreeId: indexCache.indexesByWorktreeId
  }
  return merged
}

function getWorkspaceCleanupProgressCandidateIndex(
  candidates: readonly WorkspaceCleanupCandidate[],
  scanId: string,
  scanToken: number
): {
  candidates: WorkspaceCleanupCandidate[]
  indexesByWorktreeId: Map<string, number>
} {
  if (
    workspaceCleanupProgressCandidateIndex?.scanToken === scanToken &&
    workspaceCleanupProgressCandidateIndex.scanId === scanId &&
    workspaceCleanupProgressCandidateIndex.candidates === candidates
  ) {
    return workspaceCleanupProgressCandidateIndex
  }

  return {
    candidates: [...candidates],
    indexesByWorktreeId: new Map(
      candidates.map((candidate, index) => [candidate.worktreeId, index])
    )
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

function getInitialWorkspaceCleanupGitDeferrals(state: AppState): string[] {
  const ids = new Set<string>()
  if (state.activeWorktreeId) {
    ids.add(state.activeWorktreeId)
  }

  for (const file of state.openFiles) {
    if (file.isDirty || state.editorDrafts[file.id] !== undefined) {
      ids.add(file.worktreeId)
    }
  }

  const openEditorWorktreeIds = new Set(state.openFiles.map((file) => file.worktreeId))
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tabIds = new Set(tabs.map((tab) => tab.id))
    if (tabs.some((tab) => (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0)) {
      ids.add(worktreeId)
    }
    if (hasFreshLiveAgent(state, tabIds) || hasWorkingTitleAgent(state, tabs)) {
      ids.add(worktreeId)
    }
  }

  for (const worktreeId of new Set([
    ...openEditorWorktreeIds,
    ...Object.keys(state.browserTabsByWorktree)
  ])) {
    const hasVisibleContext =
      openEditorWorktreeIds.has(worktreeId) ||
      (state.browserTabsByWorktree[worktreeId]?.length ?? 0) > 0
    const lastVisitedAt = state.lastVisitedAtByWorktreeId[worktreeId] ?? 0
    if (
      hasVisibleContext &&
      lastVisitedAt > 0 &&
      Date.now() - lastVisitedAt <= RECENT_VISIBLE_CONTEXT_MS
    ) {
      ids.add(worktreeId)
    }
  }

  // Why: these rows must stay visible, but they already need user attention.
  // Defer expensive git reads until a focused refresh/remove preflight.
  return [...ids]
}

export async function enrichWorkspaceCleanupCandidates(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  options: EnrichOptions = {}
): Promise<WorkspaceCleanupCandidate[]> {
  return Promise.all(
    candidates.map((candidate) => enrichWorkspaceCleanupCandidate(candidate, state, options))
  )
}

async function enrichWorkspaceCleanupCandidatesWithCache(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  cache: Map<string, WorkspaceCleanupEnrichmentCacheEntry>,
  options: EnrichOptions = {}
): Promise<WorkspaceCleanupCandidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      const inputSignature = getWorkspaceCleanupCandidateInputSignature(candidate)
      const localSignature = getWorkspaceCleanupLocalStateSignature(
        candidate.worktreeId,
        state,
        options
      )
      const cached = cache.get(candidate.worktreeId)
      if (cached?.inputSignature === inputSignature && cached.localSignature === localSignature) {
        return cached.candidate
      }

      const enriched = await enrichWorkspaceCleanupCandidate(candidate, state, options)
      cache.set(candidate.worktreeId, {
        inputSignature,
        localSignature,
        candidate: enriched
      })
      return enriched
    })
  )
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
  worktreeId: string,
  state: AppState,
  options: EnrichOptions
): string {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const tabIds = tabs.map((tab) => tab.id)
  const tabIdSet = new Set(tabIds)
  const openFiles = state.openFiles
    .filter((file) => file.worktreeId === worktreeId)
    .map((file) => ({
      id: file.id,
      isDirty: file.isDirty,
      hasDraft: state.editorDrafts[file.id] !== undefined
    }))
  const retainedDoneAgentPaneKeys = Object.entries(state.retainedAgentsByPaneKey)
    .filter(([, entry]) => entry.worktreeId === worktreeId && entry.entry.state === 'done')
    .map(([paneKey]) => paneKey)
    .sort()
  const agentStatuses = Object.values(state.agentStatusByPaneKey)
    .filter((entry) => tabIdSet.has(getPaneKeyTabId(entry.paneKey)))
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
      : (state.workspaceCleanupDismissals[worktreeId] ?? null)

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
    lastVisitedAt: state.lastVisitedAtByWorktreeId[worktreeId] ?? 0,
    viewed: state.workspaceCleanupViewedCandidates[worktreeId] ?? null,
    dismissal
  })
}

async function enrichWorkspaceCleanupCandidate(
  candidate: WorkspaceCleanupCandidate,
  state: AppState,
  options: EnrichOptions
): Promise<WorkspaceCleanupCandidate> {
  const tabs = state.tabsByWorktree[candidate.worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const openFiles = state.openFiles.filter((file) => file.worktreeId === candidate.worktreeId)
  const dirtyEditorBuffers = openFiles.filter(
    (file) => file.isDirty || state.editorDrafts[file.id] !== undefined
  )
  const cleanEditorTabCount = openFiles.length - dirtyEditorBuffers.length
  const browserTabCount = (state.browserTabsByWorktree[candidate.worktreeId] ?? []).length
  const retainedDoneAgentCount = Object.values(state.retainedAgentsByPaneKey).filter(
    (entry) => entry.worktreeId === candidate.worktreeId && entry.entry.state === 'done'
  ).length
  const blockers = candidate.blockers.filter((blocker) => blocker !== 'dismissed')
  const preserveCleanupInspection = shouldPreserveCleanupInspection(candidate, state)

  if (state.activeWorktreeId === candidate.worktreeId) {
    blockers.push('active-workspace')
  }
  if (dirtyEditorBuffers.length > 0) {
    blockers.push('dirty-editor-buffer')
  }
  if (hasFreshLiveAgent(state, tabIds)) {
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

  const lastVisitedAt = state.lastVisitedAtByWorktreeId[candidate.worktreeId] ?? 0
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
    : applyDismissal(enriched, state.workspaceCleanupDismissals)
}

function shouldPreserveCleanupInspection(
  candidate: WorkspaceCleanupCandidate,
  state: AppState
): boolean {
  const viewed = state.workspaceCleanupViewedCandidates[candidate.worktreeId]
  if (!viewed?.wasSuggested || viewed.fingerprint !== candidate.fingerprint) {
    return false
  }
  // Why: View is part of cleanup review. It should not make the same
  // suggested row vanish on the next scan, but this exception must expire.
  return Date.now() - viewed.viewedAt <= VIEWED_FROM_CLEANUP_MS
}

function applyDismissal(
  candidate: WorkspaceCleanupCandidate,
  dismissals: Record<string, WorkspaceCleanupDismissal>
): WorkspaceCleanupCandidate {
  if (!shouldHideWorkspaceCleanupCandidate(candidate, dismissals[candidate.worktreeId])) {
    return candidate
  }
  return applyWorkspaceCleanupPolicy({
    ...candidate,
    blockers: [...new Set<WorkspaceCleanupBlocker>([...candidate.blockers, 'dismissed'])]
  })
}

async function preflightWorkspaceCleanupCandidate(
  worktreeId: string,
  getState: () => AppState,
  approvedCandidate?: WorkspaceCleanupCandidate
): Promise<
  | { ok: true; candidate: WorkspaceCleanupCandidate }
  | { ok: false; failure: WorkspaceCleanupFailure }
> {
  const scan = await window.api.workspaceCleanup.scan({ worktreeId })
  const [candidate] = await enrichWorkspaceCleanupCandidates(scan.candidates, getState(), {
    applyDismissals: false
  })
  if (!candidate) {
    return {
      ok: false,
      failure: {
        worktreeId,
        displayName: worktreeId,
        message: translate(
          'auto.store.slices.workspace.cleanup.9d6e531da6',
          'Workspace no longer exists.'
        )
      }
    }
  }
  if (!canQueueWorkspaceCleanupCandidate(candidate)) {
    return {
      ok: false,
      failure: {
        worktreeId,
        displayName: candidate.displayName,
        message: candidate.blockers.length
          ? candidate.blockers.join(', ')
          : 'Workspace needs another look before removal.'
      }
    }
  }
  // Why: this row may be removed minutes after the confirm click. If it now
  // needs a force removal the user never approved (new dirt, unpushed work,
  // or a git error since confirmation), fail it instead of force-deleting.
  if (approvedCandidate) {
    const escalatedToForce =
      shouldForceWorkspaceCleanupRemoval(candidate) &&
      !shouldForceWorkspaceCleanupRemoval(approvedCandidate)
    // Why: an approved row that was already force-flagged for an unverifiable
    // reason must still fail when real dirt/unpushed work is now visible.
    const revealedConcreteRisk = WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS.some(
      (blocker) =>
        candidate.blockers.includes(blocker) && !approvedCandidate.blockers.includes(blocker)
    )
    if (escalatedToForce || revealedConcreteRisk) {
      return {
        ok: false,
        failure: {
          worktreeId,
          displayName: candidate.displayName,
          message: translate(
            'auto.store.slices.workspace.cleanup.changedSinceConfirmation',
            'Workspace changed after confirmation. Refresh to review it before removing.'
          )
        }
      }
    }
  }
  return { ok: true, candidate }
}

function hasFreshLiveAgent(state: AppState, tabIds: Set<string>): boolean {
  const now = Date.now()
  return Object.values(state.agentStatusByPaneKey).some(
    (entry) =>
      tabIds.has(getPaneKeyTabId(entry.paneKey)) &&
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) &&
      (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
  )
}

function hasWorkingTitleAgent(state: AppState, tabs: { id: string; title: string }[]): boolean {
  for (const tab of tabs) {
    if ((state.ptyIdsByTabId[tab.id]?.length ?? 0) === 0) {
      continue
    }
    const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
    const titles =
      paneTitles && Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
    for (const title of titles) {
      const status = classifyTitleActivity(title)
      if (status === 'working' || status === 'permission') {
        return true
      }
    }
  }
  return false
}

async function probeTerminalLiveness(
  state: AppState,
  tabs: { id: string; title: string }[]
): Promise<'idle' | 'running' | 'unknown'> {
  const ptyChecks = tabs.flatMap((tab) =>
    (state.ptyIdsByTabId[tab.id] ?? []).map((ptyId) => ({ tab, ptyId }))
  )
  if (ptyChecks.length === 0) {
    return 'idle'
  }

  let unknown = false
  for (const { tab, ptyId } of ptyChecks) {
    try {
      const [hasChildProcesses, foregroundProcess] = await Promise.all([
        window.api.pty.hasChildProcesses(ptyId),
        window.api.pty.getForegroundProcess(ptyId)
      ])
      const processName = normalizeProcessName(foregroundProcess)
      if (!hasChildProcesses && (!processName || SHELL_PROCESS_NAMES.has(processName))) {
        continue
      }
      if (
        processName &&
        AGENT_PROCESS_NAMES.has(processName) &&
        hasIdleAgentTitleForPty(state, tab, ptyId)
      ) {
        continue
      }
      return 'running'
    } catch {
      unknown = true
    }
  }

  return unknown ? 'unknown' : 'idle'
}

function hasIdleAgentTitleForPty(
  state: AppState,
  tab: { id: string; title: string },
  ptyId: string
): boolean {
  const paneTitles = state.runtimePaneTitlesByTabId[tab.id] ?? {}
  const layoutPtyIds = state.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}
  const matchingTitles = Object.entries(layoutPtyIds)
    .filter(([, leafPtyId]) => leafPtyId === ptyId)
    .map(([leafId]) => paneTitles[leafId.replace(/^pane:/, '')])
    .filter((title): title is string => typeof title === 'string')

  if (matchingTitles.length > 0) {
    return matchingTitles.some(isIdleAgentTitle)
  }

  // Why: without a pane->PTY binding, a tab-level idle title is safe evidence
  // only when this tab has a single live PTY. Multi-pane tabs stay protected.
  const tabPtyIds = state.ptyIdsByTabId[tab.id] ?? []
  if (tabPtyIds.length !== 1) {
    return false
  }

  const titles = Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
  return titles.some(isIdleAgentTitle)
}

function isIdleAgentTitle(title: string): boolean {
  return classifyTitleActivity(title) === 'idle'
}

function getPaneKeyTabId(paneKey: AgentStatusEntry['paneKey']): string {
  const separatorIndex = paneKey.lastIndexOf(':')
  return separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
}

function normalizeProcessName(value: string | null): string | null {
  if (!value) {
    return null
  }
  const normalizedPath = value.replace(/\\/g, '/')
  const name = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1).toLowerCase()
  return name.replace(/\.exe$/i, '.exe')
}
