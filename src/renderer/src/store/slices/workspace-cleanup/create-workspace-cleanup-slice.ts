import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissal,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanProgress,
  type WorkspaceCleanupScanResult,
  type WorkspaceCleanupUnverifiedRemovalConsent
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateHostId,
  getWorkspaceCleanupCandidateIdentity
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { hydrateWorkspaceCleanupScanFromCache } from './workspace-cleanup-cache-hydration'
import {
  applyWorkspaceCleanupDismissal,
  enrichWorkspaceCleanupCandidates
} from './workspace-cleanup-candidate-enrichment'
import { scanWorkspaceCleanup } from './workspace-cleanup-scan-lifecycle'
import {
  removeWorkspaceCleanupCandidates,
  type WorkspaceCleanupRemoveOptions,
  type WorkspaceCleanupRemoveResult
} from './workspace-cleanup-removal'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'

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
    const { workspaceCleanupDismissals: dismissals, workspaceCleanupScan: scan } = get()
    const restored = new Set(candidates.map(getWorkspaceCleanupCandidateIdentity))
    const worktreeIds = new Set(candidates.map((candidate) => candidate.worktreeId))
    // Legacy dismissals are keyed by bare worktree id and cover every host; drop that key too or the row stays ignored.
    const restoredDismissalKeys = [...restored, ...worktreeIds]
    // Re-key a dropped legacy dismissal onto the other hosts it covered so only the restored row un-ignores.
    const migrated: WorkspaceCleanupDismissal[] = (scan?.candidates ?? []).flatMap((candidate) => {
      const legacy = dismissals[candidate.worktreeId]
      const identity = getWorkspaceCleanupCandidateIdentity(candidate)
      return legacy &&
        worktreeIds.has(candidate.worktreeId) &&
        !restored.has(identity) &&
        !dismissals[identity]
        ? [{ ...legacy, executionHostId: getWorkspaceCleanupCandidateHostId(candidate) }]
        : []
    })
    // Persist first: a failed restore must not leave the row eligible for bulk delete.
    await window.api.workspaceCleanup.dismiss({ dismissals: migrated, restoredDismissalKeys })
    set((state) => {
      const next = { ...state.workspaceCleanupDismissals }
      for (const key of restoredDismissalKeys) {
        delete next[key]
      }
      for (const dismissal of migrated) {
        next[getWorkspaceCleanupCandidateIdentity(dismissal)] = dismissal
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

// Streamed frames merge from the progress copy, so both copies must carry the new dismissal state.
function withWorkspaceCleanupDismissals(
  state: AppState,
  dismissals: Record<string, WorkspaceCleanupDismissal>
): Pick<
  AppState,
  'workspaceCleanupDismissals' | 'workspaceCleanupScan' | 'workspaceCleanupProgress'
> {
  const reconcile = <T extends { candidates: WorkspaceCleanupCandidate[] }>(
    snapshot: T | null
  ): T | null =>
    snapshot && {
      ...snapshot,
      candidates: snapshot.candidates.map((candidate) =>
        applyWorkspaceCleanupDismissal(candidate, dismissals)
      )
    }
  return {
    workspaceCleanupDismissals: dismissals,
    workspaceCleanupScan: reconcile(state.workspaceCleanupScan),
    workspaceCleanupProgress: reconcile(state.workspaceCleanupProgress)
  }
}
