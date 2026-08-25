import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

type SnapshotFreshness = {
  publicationEpoch: string
  snapshotVersion: number
}

export type WebSessionTabsNotificationPaneEvidence = {
  ownerId: number
  worktree: string
  paneIncarnation: number
}

export type WebSessionTabsNotificationTrackedWorktree = {
  worktree: string
  freshness: SnapshotFreshness
}

type NotificationWorktreeState = SnapshotFreshness & {
  eligible: boolean
  paneIncarnations: ReadonlyMap<string, number>
  resumeAttentionPending: boolean
}

export type WebSessionTabsNotificationObservation = {
  seedOnly: boolean
  attentionRequired: boolean
  paneEvidenceByKey: ReadonlyMap<string, WebSessionTabsNotificationPaneEvidence>
}

export type WebSessionTabsNotificationReconciler = {
  observeSnapshot: (snapshot: RuntimeMobileSessionTabsResult) => boolean
  observeInventory: (
    snapshots: readonly RuntimeMobileSessionTabsResult[],
    options: { armPublished: boolean }
  ) => void
  armPresentWorktrees: () => void
  beginVisibilityResume: () => void
  endVisibilityResume: () => void
  dispose: () => void
}

const worktreesByEvidenceOwner = new Map<number, ReadonlyMap<string, NotificationWorktreeState>>()
let nextEvidenceOwnerId = 0
let nextPaneIncarnation = 0

export function isCurrentWebSessionTabsNotificationPaneEvidence(
  evidence: WebSessionTabsNotificationPaneEvidence,
  paneKey: string
): boolean {
  return (
    worktreesByEvidenceOwner
      .get(evidence.ownerId)
      ?.get(evidence.worktree)
      ?.paneIncarnations.get(paneKey) === evidence.paneIncarnation
  )
}

function isRemoval(snapshot: RuntimeMobileSessionTabsResult): boolean {
  return (snapshot as { removed?: unknown }).removed === true
}

function advancesFreshness(
  snapshot: RuntimeMobileSessionTabsResult,
  current: NotificationWorktreeState
): boolean {
  return (
    snapshot.publicationEpoch !== current.publicationEpoch ||
    snapshot.snapshotVersion > current.snapshotVersion
  )
}

export function createWebSessionTabsNotificationReconciler(args: {
  trackedWorktrees: readonly WebSessionTabsNotificationTrackedWorktree[]
  getPaneKeys: (snapshot: RuntimeMobileSessionTabsResult) => readonly string[]
  observeAcceptedSnapshot: (
    snapshot: RuntimeMobileSessionTabsResult,
    observation: WebSessionTabsNotificationObservation
  ) => void
}): WebSessionTabsNotificationReconciler {
  const ownerId = (nextEvidenceOwnerId += 1)
  const worktrees = new Map<string, NotificationWorktreeState>(
    args.trackedWorktrees.map(({ worktree, freshness }) => [
      worktree,
      {
        ...freshness,
        eligible: true,
        paneIncarnations: new Map(),
        resumeAttentionPending: false
      }
    ])
  )
  worktreesByEvidenceOwner.set(ownerId, worktrees)

  const paneIncarnationsForSnapshot = (
    snapshot: RuntimeMobileSessionTabsResult,
    current: NotificationWorktreeState | undefined
  ): ReadonlyMap<string, number> => {
    const paneIncarnations = new Map<string, number>()
    for (const paneKey of args.getPaneKeys(snapshot)) {
      paneIncarnations.set(
        paneKey,
        current?.paneIncarnations.get(paneKey) ?? (nextPaneIncarnation += 1)
      )
    }
    return paneIncarnations
  }

  const observeAcceptedSnapshot = (snapshot: RuntimeMobileSessionTabsResult): boolean => {
    const current = worktrees.get(snapshot.worktree)
    if (isRemoval(snapshot)) {
      worktrees.delete(snapshot.worktree)
      return current !== undefined
    }
    if (current && !advancesFreshness(snapshot, current)) {
      return false
    }
    const eligible = current?.eligible === true
    const paneIncarnations = paneIncarnationsForSnapshot(snapshot, current)
    const state = {
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      eligible,
      paneIncarnations,
      resumeAttentionPending: false
    }
    worktrees.set(snapshot.worktree, state)
    const paneEvidenceByKey = new Map<string, WebSessionTabsNotificationPaneEvidence>()
    for (const [paneKey, paneIncarnation] of paneIncarnations) {
      paneEvidenceByKey.set(paneKey, { ownerId, worktree: snapshot.worktree, paneIncarnation })
    }
    args.observeAcceptedSnapshot(snapshot, {
      seedOnly: !eligible,
      attentionRequired: eligible && current?.resumeAttentionPending === true,
      paneEvidenceByKey
    })
    return true
  }

  return {
    observeSnapshot: (snapshot) => {
      const accepted = observeAcceptedSnapshot(snapshot)
      const state = worktrees.get(snapshot.worktree)
      if (state) {
        state.eligible = true
      }
      return accepted
    },
    observeInventory: (snapshots, options) => {
      const publishedWorktrees = new Set<string>()
      for (const snapshot of snapshots) {
        publishedWorktrees.add(snapshot.worktree)
        observeAcceptedSnapshot(snapshot)
      }
      for (const worktree of worktrees.keys()) {
        if (!publishedWorktrees.has(worktree)) {
          worktrees.delete(worktree)
        }
      }
      if (options.armPublished) {
        for (const worktree of publishedWorktrees) {
          const state = worktrees.get(worktree)
          if (state) {
            state.eligible = true
          }
        }
      }
      for (const state of worktrees.values()) {
        state.resumeAttentionPending = false
      }
    },
    armPresentWorktrees: () => {
      for (const state of worktrees.values()) {
        state.eligible = true
      }
    },
    beginVisibilityResume: () => {
      for (const state of worktrees.values()) {
        state.resumeAttentionPending = true
      }
    },
    endVisibilityResume: () => {
      for (const state of worktrees.values()) {
        state.resumeAttentionPending = false
      }
    },
    dispose: () => {
      worktreesByEvidenceOwner.delete(ownerId)
    }
  }
}
