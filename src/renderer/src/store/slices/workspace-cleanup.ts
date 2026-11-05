import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissal,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanProgress,
  type WorkspaceCleanupScanResult,
  type WorkspaceCleanupUnverifiedRemovalConsent
} from '../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateHostId,
  getWorkspaceCleanupCandidateIdentity
} from '../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { hydrateWorkspaceCleanupScanFromCache } from './workspace-cleanup-cache-hydration'
import {
  applyWorkspaceCleanupDismissal,
  enrichWorkspaceCleanupCandidates,
  WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY
} from './workspace-cleanup-candidate-enrichment'
import { scanWorkspaceCleanup } from './workspace-cleanup-scan-lifecycle'
import {
  removeWorkspaceCleanupCandidates,
  type WorkspaceCleanupFailure,
  type WorkspaceCleanupRemoveOptions,
  type WorkspaceCleanupRemoveResult
} from './workspace-cleanup-removal'
import { createBrowserUuid } from '@/lib/browser-uuid'

export type { WorkspaceCleanupFailure, WorkspaceCleanupRemoveOptions, WorkspaceCleanupRemoveResult }
export { enrichWorkspaceCleanupCandidates, WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY }

type WorkspaceCleanupViewedCandidate = {
  viewedAt: number
  fingerprint: string
}

const unverifiedRemovalConsentByStore = new WeakMap<() => AppState, Map<string, string>>()

export type WorkspaceCleanupSlice = {
  workspaceCleanupScan: WorkspaceCleanupScanResult | null
  workspaceCleanupProgress: WorkspaceCleanupScanProgress | null
  workspaceCleanupLoading: boolean
  workspaceCleanupError: string | null
  workspaceCleanupDismissals: Record<string, WorkspaceCleanupDismissal>
  workspaceCleanupViewedCandidates: Record<string, WorkspaceCleanupViewedCandidate>
  scanWorkspaceCleanup: (args?: WorkspaceCleanupScanArgs) => Promise<WorkspaceCleanupScanResult>
  hydrateWorkspaceCleanupFromCache: () => Promise<boolean>
  markWorkspaceCleanupCandidateViewed: (candidate: WorkspaceCleanupCandidate) => void
  dismissWorkspaceCleanupCandidates: (
    candidates: readonly WorkspaceCleanupCandidate[]
  ) => Promise<void>
  /** Undo "Ignore" for these rows only; other hosts' copies of the same worktree stay ignored. */
  restoreWorkspaceCleanupCandidates: (
    candidates: readonly WorkspaceCleanupCandidate[]
  ) => Promise<void>
  resetWorkspaceCleanupDismissals: () => Promise<void>
  beginUnverifiedRemovalConsent: (identity: string) => string | null
  removeWorkspaceCleanupCandidates: (
    worktreeIds: readonly string[],
    options?: WorkspaceCleanupRemoveOptions
  ) => Promise<WorkspaceCleanupRemoveResult>
}

const VIEWED_FROM_CLEANUP_MS = 2 * 60 * 60 * 1000

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
  scanWorkspaceCleanup: (args) => scanWorkspaceCleanup(get, set, args),
  hydrateWorkspaceCleanupFromCache: () =>
    hydrateWorkspaceCleanupScanFromCache({
      hasLiveScanState: () => get().workspaceCleanupScan !== null || get().workspaceCleanupLoading,
      enrich: (candidates) => enrichWorkspaceCleanupCandidates(candidates, get()),
      apply: (scan) => set({ workspaceCleanupScan: scan })
    }),
  markWorkspaceCleanupCandidateViewed: (candidate) => {
    const now = Date.now()
    set((state) => ({
      workspaceCleanupViewedCandidates: {
        ...Object.fromEntries(
          Object.entries(state.workspaceCleanupViewedCandidates).filter(
            ([, viewed]) => now - viewed.viewedAt <= VIEWED_FROM_CLEANUP_MS
          )
        ),
        [candidate.worktreeId]: {
          viewedAt: now,
          fingerprint: candidate.fingerprint
        }
      }
    }))
  },
  dismissWorkspaceCleanupCandidates: async (candidates) => {
    const now = Date.now()
    const dismissals = candidates.map((candidate) => ({
      worktreeId: candidate.worktreeId,
      executionHostId: getWorkspaceCleanupCandidateHostId(candidate),
      dismissedAt: now,
      fingerprint: candidate.fingerprint,
      classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION
    }))
    set((state) => {
      const next = { ...state.workspaceCleanupDismissals }
      for (const dismissal of dismissals) {
        next[getWorkspaceCleanupCandidateIdentity(dismissal)] = dismissal
      }
      return withWorkspaceCleanupDismissals(state, next)
    })
    await window.api.workspaceCleanup.dismiss({ dismissals })
  },
  restoreWorkspaceCleanupCandidates: async (candidates) => {
    // Legacy dismissals are keyed by bare worktree id; drop that key too or the row stays ignored.
    const restoredDismissalKeys = [
      ...new Set(
        candidates.flatMap((candidate) => [
          getWorkspaceCleanupCandidateIdentity(candidate),
          candidate.worktreeId
        ])
      )
    ]
    // Persist first: a failed restore must not leave the row eligible for bulk delete.
    await window.api.workspaceCleanup.dismiss({ dismissals: [], restoredDismissalKeys })
    set((state) => {
      const next = { ...state.workspaceCleanupDismissals }
      for (const key of restoredDismissalKeys) {
        delete next[key]
      }
      return withWorkspaceCleanupDismissals(state, next)
    })
  },
  resetWorkspaceCleanupDismissals: async () => {
    set((state) => withWorkspaceCleanupDismissals(state, {}))
    await window.api.workspaceCleanup.clearDismissals()
  },
  beginUnverifiedRemovalConsent: (identity) => {
    const existing = unverifiedRemovalConsentByStore.get(get) ?? new Map<string, string>()
    unverifiedRemovalConsentByStore.set(get, existing)
    if (existing.has(identity)) {
      return null
    }
    const attemptId = createBrowserUuid()
    existing.set(identity, attemptId)
    return attemptId
  },
  removeWorkspaceCleanupCandidates: (worktreeIds, options) =>
    removeWorkspaceCleanupCandidates(get, set, worktreeIds, {
      ...options,
      getConsentAttemptId: (identity) => unverifiedRemovalConsentByStore.get(get)?.get(identity)
    }).finally(() => {
      const consent = options?.unverifiedRemovalConsent as
        | WorkspaceCleanupUnverifiedRemovalConsent
        | undefined
      if (
        consent &&
        unverifiedRemovalConsentByStore.get(get)?.get(consent.identity) === consent.attemptId
      ) {
        unverifiedRemovalConsentByStore.get(get)?.delete(consent.identity)
      }
    })
})

function withWorkspaceCleanupDismissals(
  state: AppState,
  dismissals: Record<string, WorkspaceCleanupDismissal>
): Pick<AppState, 'workspaceCleanupDismissals' | 'workspaceCleanupScan'> {
  return {
    workspaceCleanupDismissals: dismissals,
    workspaceCleanupScan: state.workspaceCleanupScan
      ? {
          ...state.workspaceCleanupScan,
          candidates: state.workspaceCleanupScan.candidates.map((candidate) =>
            applyWorkspaceCleanupDismissal(candidate, dismissals)
          )
        }
      : state.workspaceCleanupScan
  }
}
