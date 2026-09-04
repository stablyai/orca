import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorkspaceColorTagFallbackIdentity,
  getWorkspaceColorTagIdentity
} from '../../../../shared/workspace-color-tag'
import {
  clearWorkspaceColorTagPreviews,
  createWorkspaceColorTagPreviewOwner,
  previewWorkspaceColorTagsFor,
  workspaceColorTagPreviewKeysFor,
  type WorkspaceColorTagPreviewOwner
} from './workspace-color-tag-preview'

type WorktreeMetaWriteResult = { ok: true } | { ok: false; error: string }

/** Shape of the store's updateWorktreeMeta, narrowed to what a color write needs. */
export type WorkspaceColorTagWriter = (
  worktreeId: string,
  updates: { colorTag: string | null },
  options?: {
    executionHostId?: ExecutionHostId
    identityKey?: string
    runtimeOwnerEnvironmentId?: string | null
  }
) => Promise<WorktreeMetaWriteResult>

type PendingWrite = {
  worktree: Worktree
  colorTag: string | null
  onError: (message: string) => void
  /** Resolvers for every assignment this value satisfies, its own and any it superseded. */
  settle: (() => void)[]
}

type IdentityQueue = {
  inFlight: boolean
  pending: PendingWrite | undefined
  /** Row carrying the canonical identity this queue serves; later writes are pinned with it. */
  canonicalRow: Worktree | undefined
  /** Keys previewed under; cleared together on drain. */
  previewIdentities: Set<string>
  /** Every representation that enqueued here; all of them show the newest pending color. */
  previewRows: Map<string, Worktree>
  /** Per queue, so a predecessor's drain never clears a successor's pending preview. */
  previewOwner: WorkspaceColorTagPreviewOwner
  /** The pre-identity key this queue currently answers to. */
  fallbackKey: string
  /** Creation order; a pre-identity key only ever moves to a newer queue. */
  sequence: number
}

// One queue per workspace, shared by every menu instance: writes serialize no matter which card
// issued them, and the newest pending color is what lands next. The writer is injected.
const queues = new Map<string, IdentityQueue>()
let nextQueueSequence = 0
/** The newest queue ever to claim each pre-identity key; only it may take the key back on a drain. */
const latestClaim = new Map<string, number>()

/**
 * Assign `colorTag` to every target. Resolves once each target's write, or a newer one that
 * superseded it, has landed. A refused or failed write is reported once per call.
 */
export function assignWorkspaceColorTags(
  targets: readonly Worktree[],
  colorTag: string | null,
  write: WorkspaceColorTagWriter,
  onError: (message: string) => void
): Promise<void> {
  let reported = false
  const reportOnce = (message: string): void => {
    if (reported) {
      return
    }
    reported = true
    onError(message)
  }
  return Promise.all(
    targets.map((worktree) => enqueue(worktree, colorTag, write, reportOnce))
  ).then(() => undefined)
}

function enqueue(
  worktree: Worktree,
  colorTag: string | null,
  write: WorkspaceColorTagWriter,
  onError: (message: string) => void
): Promise<void> {
  const current = queueFor(worktree)
  // Every representation of the workspace shows the newest color at once; pre-identity layers stay
  // scoped to the occupant so a replacement checkout never inherits them.
  current.previewRows.set(getWorkspaceColorTagIdentity(worktree), worktree)
  const rows = [...current.previewRows.values()]
  for (const key of workspaceColorTagPreviewKeysFor(rows)) {
    current.previewIdentities.add(key)
  }
  previewWorkspaceColorTagsFor(
    rows,
    colorTag,
    current.previewOwner,
    current.canonicalRow?.identity?.key
  )
  return new Promise<void>((resolve) => {
    // Latest wins; a superseded assignment settles when the newer write lands.
    current.pending = {
      worktree,
      colorTag,
      onError,
      settle: [...(current.pending?.settle ?? []), resolve]
    }
    if (!current.inFlight) {
      drain(current, write)
    }
  })
}

// Resolution order: the canonical key, then an identity-less queue already open under the same
// pre-identity key (a refresh promoted the row mid-flight). Two canonical queues sharing a
// pre-identity key (two HUBs' rows for one checkout) stay separate.
function queueFor(worktree: Worktree): IdentityQueue {
  const identity = getWorkspaceColorTagIdentity(worktree)
  const canonical = worktree.identity?.key
  const fallback =
    canonical === undefined ? identity : getWorkspaceColorTagFallbackIdentity(worktree)
  const direct = queues.get(identity)
  if (direct) {
    if (canonical !== undefined) {
      // A rename keeps the identity but moves the pre-identity key; follow it, or a copy of the
      // renamed row that has not refreshed yet opens a second queue.
      direct.canonicalRow = worktree
      claimFallback(direct, fallback)
    }
    return direct
  }
  const byFallback = queues.get(fallback)
  if (canonical !== undefined && byFallback && byFallback.canonicalRow === undefined) {
    byFallback.canonicalRow = worktree
    queues.set(identity, byFallback)
    return byFallback
  }
  const queue: IdentityQueue = {
    inFlight: false,
    pending: undefined,
    canonicalRow: canonical === undefined ? undefined : worktree,
    previewIdentities: new Set(),
    previewRows: new Map(),
    previewOwner: createWorkspaceColorTagPreviewOwner(),
    fallbackKey: fallback,
    sequence: ++nextQueueSequence
  }
  queues.set(identity, queue)
  claimFallback(queue, fallback)
  return queue
}

/** The newest occupant owns a pre-identity key; an older queue never takes it from a newer one. */
function claimFallback(queue: IdentityQueue, fallback: string): void {
  if (queue.fallbackKey !== fallback && latestClaim.get(queue.fallbackKey) === queue.sequence) {
    latestClaim.delete(queue.fallbackKey)
  }
  queue.fallbackKey = fallback
  const holder = queues.get(fallback)
  if (holder && holder !== queue && holder.sequence > queue.sequence) {
    return
  }
  queues.set(fallback, queue)
  latestClaim.set(fallback, Math.max(latestClaim.get(fallback) ?? 0, queue.sequence))
}

function drain(queue: IdentityQueue, write: WorkspaceColorTagWriter): void {
  const next = queue.pending
  queue.pending = undefined
  if (!next) {
    queue.inFlight = false
    clearWorkspaceColorTagPreviews([...queue.previewIdentities], queue.previewOwner)
    queue.previewIdentities.clear()
    queue.previewRows.clear()
    for (const [key, registered] of queues) {
      if (registered === queue) {
        queues.delete(key)
      }
    }
    // Only the latest claimant may take the pre-identity key back; a predecessor or a superseded
    // intermediate never does, so later writes cannot be pinned to a row on its way out.
    const remaining = [...new Set(queues.values())].filter(
      (registered) => registered.fallbackKey === queue.fallbackKey
    )
    if (remaining.length === 0) {
      latestClaim.delete(queue.fallbackKey)
    } else if (!queues.has(queue.fallbackKey)) {
      const survivor = remaining.find(
        (registered) => registered.sequence === latestClaim.get(queue.fallbackKey)
      )
      if (survivor) {
        queues.set(queue.fallbackKey, survivor)
      }
    }
    return
  }
  queue.inFlight = true
  // A copy without an identity is pinned with the queue's canonical row, so a checkout replaced at
  // the same path never receives the write; a `null` owner marks a row the desktop lists itself.
  const pinRow = next.worktree.identity?.key ? next.worktree : (queue.canonicalRow ?? next.worktree)
  write(
    next.worktree.id,
    { colorTag: next.colorTag },
    {
      executionHostId: next.worktree.hostId ?? 'local',
      identityKey: pinRow.identity?.key,
      runtimeOwnerEnvironmentId: pinRow.runtimeOwnerEnvironmentId ?? null
    }
  )
    .then(
      (result) => {
        // An older host refuses with ok:false; surface it, or the strip just vanishes on refresh.
        if (!result.ok) {
          next.onError(result.error)
        }
      },
      (error: unknown) => {
        next.onError(error instanceof Error ? error.message : String(error))
      }
    )
    .then(() => {
      for (const settle of next.settle) {
        settle()
      }
      drain(queue, write)
    })
}
