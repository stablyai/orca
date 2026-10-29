import type { WorktreeSlice } from '../../worktree-helpers'
import { runtimeTargetForWorktreeOwner } from '../listing/worktree-owner-target'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { branchName } from '@/lib/git-utils'
import { detachedHeadAutoDerivedDisplayNames } from './detached-head-display-name'
import {
  applyHostedReviewLinkClear,
  canonicalHostedReviewBranchIdentity,
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  getHostedReviewLinkMutationGeneration,
  getHostedReviewLinkUpdates,
  hasBranchScopedHostedReviewContext,
  hostedReviewLinkClearTombstonesByCopy,
  hostedReviewLinksAreCleared,
  rememberHostedReviewLinkClear,
  resolveHostedReviewLinkWorktreeId
} from './hosted-review-link-mutation'
import {
  reviewClearTombstoneKey,
  worktreeCopyOwnerKey,
  type WorktreeCopyClear
} from './worktree-copy-review-clear'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { withRepoHostOwnership } from '../listing/worktree-host-ownership'
import { getRepoRegistrationHostIds } from '../../../../../../shared/repo-host-identity'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  selectWorkspaceByHostTarget,
  selectWorktreesByRepo,
  type WorkspaceRecordState
} from '../../../workspace-record-selectors'

type GitIdentityTargets = {
  rows: Set<Worktree>
  /** Rows with this id exist on more than one host. */
  isTwin: boolean
}

/**
 * The rows one host's git answer for `worktreeId` describes. Ids are `repoId::path`, so a same-path
 * twin on another host shares it. An id on one host keeps the id-only patch; a twin needs the
 * answering host, and without one gets nothing until its listing places each copy.
 */
function gitIdentityTargets(
  state: WorkspaceRecordState,
  worktreeId: string,
  ownerHostId: ExecutionHostId | null
): GitIdentityTargets {
  const rows = (selectWorktreesByRepo(state)[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
    (worktree) => worktree.id === worktreeId
  )
  // Why provenance too: two paired servers can each publish the same `ssh:` host id.
  const owners = new Set(rows.map(worktreeCopyOwnerKey))
  if (owners.size <= 1) {
    return { rows: new Set(rows), isTwin: false }
  }
  if (!ownerHostId) {
    return { rows: new Set(), isTwin: true }
  }
  // Why the host target: it also places a paired server's SSH checkout under its `runtime:` alias.
  const row = selectWorkspaceByHostTarget(
    state,
    hostWorktreeTarget({ id: worktreeId, hostId: ownerHostId })
  )
  return { rows: new Set(row ? [row] : []), isTwin: true }
}

/** The one host registering `repoId`, which its listings stamp rows with; else undefined. */
function soleRegistrationHostId(
  repos: Parameters<typeof getRepoRegistrationHostIds>[0],
  repoId: string
): ExecutionHostId | undefined {
  const hosts = getRepoRegistrationHostIds(repos, repoId)
  return hosts.size === 1 ? [...hosts][0] : undefined
}

export function createUpdateWorktreeGitIdentity(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeGitIdentity'] {
  return (worktreeId, identity, ownerHostId) => {
    let shouldPersistHostedReviewClear = false
    let clearedBranch: string | null = null
    let clearedCopy: WorktreeCopyClear | undefined
    let clearedOnTwin = false
    let clearGeneration = getHostedReviewLinkMutationGeneration(worktreeId)
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const nextHeadFor = (worktree: Worktree): string => identity.head ?? worktree.head
    const nextBranchFor = (worktree: Worktree): string =>
      identity.branch === null ? '' : (identity.branch ?? worktree.branch)
    const initialTargets = gitIdentityTargets(get(), worktreeId, ownerHostId)
    const anyTargetChanges = [...initialTargets.rows].some(
      (worktree) =>
        nextHeadFor(worktree) !== worktree.head || nextBranchFor(worktree) !== worktree.branch
    )
    if (!anyTargetChanges) {
      return
    }

    set((s) => {
      const current = s.worktreesByRepo[repoId]
      if (!current) {
        return s
      }

      let changed = false
      const targets = gitIdentityTargets(s, worktreeId, ownerHostId)
      const next = current.map((worktree) => {
        if (!targets.rows.has(worktree)) {
          return worktree
        }
        const nextHead = nextHeadFor(worktree)
        const nextBranch = nextBranchFor(worktree)
        if (nextHead === worktree.head && nextBranch === worktree.branch) {
          return worktree
        }
        changed = true
        const hostedReviewBranchChanged =
          canonicalHostedReviewBranchIdentity(nextBranch) !==
          canonicalHostedReviewBranchIdentity(worktree.branch)
        const shouldClearHostedReviewContext =
          hostedReviewBranchChanged && hasBranchScopedHostedReviewContext(worktree)
        // Why the copy: a same-path twin shares the id, so every guard and clear names this row.
        // Keyed by the stamp the next listing gives the row, so legacy or partial stamps still match.
        // Only missing parts are filled in; a row's own host or publishing server is never replaced.
        const stampHostId = soleRegistrationHostId(s.repos, worktree.repoId) ?? ownerHostId
        const listingStamp = stampHostId ? withRepoHostOwnership(worktree, stampHostId) : worktree
        const stampedHostId = worktree.hostId ?? listingStamp.hostId
        // Provenance only distinguishes SSH copies; local listings never carry it.
        const stamped = {
          hostId: stampedHostId,
          runtimeOwnerEnvironmentId:
            worktree.runtimeOwnerEnvironmentId ??
            (parseExecutionHostId(stampedHostId)?.kind === 'ssh'
              ? listingStamp.runtimeOwnerEnvironmentId
              : undefined)
        }
        const copy = {
          owner: worktreeCopyOwnerKey(stamped),
          rowOwner: worktreeCopyOwnerKey(worktree),
          hostId: worktree.hostId
        }
        if (shouldClearHostedReviewContext) {
          shouldPersistHostedReviewClear = true
          clearedBranch = nextBranch
          clearedCopy = copy
          clearedOnTwin = targets.isTwin
          clearGeneration = getHostedReviewLinkMutationGeneration(worktreeId)
          rememberHostedReviewLinkClear(worktreeId, nextBranch, clearGeneration, nextHead, copy)
        } else {
          const tombstoneKey = reviewClearTombstoneKey(worktreeId, copy.owner)
          const tombstone = hostedReviewLinkClearTombstonesByCopy.get(tombstoneKey)
          if (tombstone) {
            clearedCopy = copy
            clearedOnTwin = targets.isTwin
            const nextBranchIdentity = canonicalHostedReviewBranchIdentity(nextBranch)
            hostedReviewLinkClearTombstonesByCopy.set(tombstoneKey, {
              ...tombstone,
              branch: nextBranch,
              branchIdentity: nextBranchIdentity,
              head: nextHead
            })
            if (hostedReviewBranchChanged) {
              shouldPersistHostedReviewClear = true
              clearedBranch = nextBranch
              clearGeneration = tombstone.generation
            }
          }
        }
        // Why: terminal branch switches only patch branch/head here; re-derive auto titles like full listing does.
        const currentBranchName = branchName(worktree.branch)
        const wasAutoDerived =
          worktree.displayNameMode === 'automatic' ||
          (worktree.displayNameMode === undefined &&
            worktree.cliProvenance?.kind !== 'created-by-cli' &&
            worktree.displayName === currentBranchName)
        const wasDetachedAutoDerived =
          worktree.branch === '' &&
          nextBranch !== '' &&
          detachedHeadAutoDerivedDisplayNames.get(worktreeId) === worktree.displayName
        const nextDisplayName =
          (wasAutoDerived || wasDetachedAutoDerived) && nextBranch
            ? branchName(nextBranch)
            : worktree.displayName
        if (identity.branch === null && wasAutoDerived) {
          detachedHeadAutoDerivedDisplayNames.set(worktreeId, worktree.displayName)
        } else if (identity.branch !== undefined) {
          detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
        }
        return {
          ...worktree,
          head: nextHead,
          branch: nextBranch,
          displayName: nextDisplayName,
          ...(shouldClearHostedReviewContext
            ? normalizeWorkspaceAttachmentUpdate(worktree, CLEARED_HOSTED_REVIEW_LINK_UPDATES)
            : {})
        }
      })

      if (!changed) {
        return s
      }

      return {
        worktreesByRepo: { ...s.worktreesByRepo, [repoId]: next },
        sortEpoch: s.sortEpoch + 1
      }
    })
    if (!shouldPersistHostedReviewClear || clearedBranch === null) {
      return
    }
    const clearCopy = clearedCopy
    if (!clearCopy) {
      return
    }
    // Why: for a twin every read, clear and save below stays on the copy this answer patched.
    const ownerForTwin = clearedOnTwin ? (ownerHostId ?? undefined) : undefined
    const readRow = (id: string) => get().getKnownWorktreeById(id, ownerForTwin)
    const persistTo = (id: string) => runtimeTargetForWorktreeOwner(get(), id, ownerForTwin)
    // Why both: main matches an unstamped local twin by the answering host, not the row stamp.
    const persistHostId = ownerHostId ?? clearCopy.hostId

    void Promise.resolve()
      .then(async () => {
        let currentWorktreeId = resolveHostedReviewLinkWorktreeId(worktreeId)
        const persistedWorktreeIds = new Set<string>()
        while (true) {
          currentWorktreeId = resolveHostedReviewLinkWorktreeId(currentWorktreeId)
          if (persistedWorktreeIds.has(currentWorktreeId)) {
            return
          }
          persistedWorktreeIds.add(currentWorktreeId)
          let current = readRow(currentWorktreeId)
          if (
            !current ||
            current.branch !== clearedBranch ||
            getHostedReviewLinkMutationGeneration(currentWorktreeId) !== clearGeneration
          ) {
            return
          }
          if (!hostedReviewLinksAreCleared(current as Worktree)) {
            // Why: a refetch can rehydrate stale linked-review metadata before this async clear starts; clear it again.
            applyHostedReviewLinkClear(set, currentWorktreeId, clearCopy)
            current = readRow(currentWorktreeId)
            if (!current || current.branch !== clearedBranch) {
              return
            }
          }
          await persistWorktreeMeta(
            persistTo(currentWorktreeId),
            currentWorktreeId,
            CLEARED_HOSTED_REVIEW_LINK_UPDATES,
            persistHostId
          )
          const migratedWorktreeId = resolveHostedReviewLinkWorktreeId(currentWorktreeId)
          if (migratedWorktreeId === currentWorktreeId) {
            break
          }
          // Why: worktree creation can migrate ids mid-IPC; persist the clear under the new durable id too.
          currentWorktreeId = migratedWorktreeId
        }
        const latest = readRow(currentWorktreeId)
        if (
          !latest ||
          latest.branch !== clearedBranch ||
          hostedReviewLinksAreCleared(latest as Worktree)
        ) {
          return
        }
        if (getHostedReviewLinkMutationGeneration(currentWorktreeId) !== clearGeneration) {
          // Why: a delayed branch-switch clear must not win over a newer manual relink.
          await persistWorktreeMeta(
            persistTo(currentWorktreeId),
            currentWorktreeId,
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a visible or detected row; both carry every review-link field read here.
            getHostedReviewLinkUpdates(latest as Worktree),
            persistHostId
          )
          return
        }
        // Why: a refetch can rehydrate old metadata before the branch-switch clear reaches disk; don't write the stale link back.
        applyHostedReviewLinkClear(set, currentWorktreeId, clearCopy)
      })
      .catch((err) => {
        if (isRuntimeSelectorNotFoundError(err)) {
          void get().fetchWorktrees(
            getRepoIdFromWorktreeId(resolveHostedReviewLinkWorktreeId(worktreeId))
          )
          return
        }
        console.error('Failed to persist branch-scoped review link clear:', err)
      })
  }
}
