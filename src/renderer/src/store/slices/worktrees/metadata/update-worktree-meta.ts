import {
  hasExplicitWorkspaceReviewSelection,
  getWorkspaceReviewPersistenceUpdates,
  getWorkspaceReviewRefreshHints
} from './workspace-attachment-review-selection'
import {
  getWorkspaceAttachments,
  normalizeWorkspaceAttachmentUpdate
} from '../../../../../../shared/workspace-attachments'
import { normalizeGitHubPRSuppressionUpdate } from '../../../../../../shared/worktree/github-pr-suppression'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { translate } from '@/i18n/i18n'
import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import { displayNameUpdatePinsLabel } from '../../../../../../shared/worktree/display-name-provenance'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import {
  findKnownWorktreeById,
  getFolderWorkspaceMetaUpdates
} from '../listing/detected-worktree-meta'
import {
  bumpHostedReviewLinkMutationGeneration,
  hasChangedHostedReviewLinkUpdates,
  hasHostedReviewLinkUpdates
} from './hosted-review-link-mutation'
import {
  getHostedReviewPushTargetLookup,
  resolveGitHubReviewPushTarget
} from './hosted-review-push-target'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { buildWorktreeMetaStateUpdate } from './worktree-meta-state-update'
import { withPendingSidebarRowWrites } from '@/lib/sidebar-pending-layer'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import { runtimeTargetForWorktreeOwner } from '../listing/worktree-owner-target'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'

import { findRepoForHost } from '../../repo-host-identity'
export function createUpdateWorktreeMeta(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeMeta'] {
  const update: WorktreeSlice['updateWorktreeMeta'] = async (worktreeId, updates, options) => {
    const shouldApplyUpdate = options?.shouldApply
    const requestedHostId = options?.executionHostId
    const existingWorktree = findKnownWorktreeById(get(), worktreeId, requestedHostId)
    const executionHostId =
      requestedHostId ??
      existingWorktree?.hostId ??
      (get().settings?.activeRuntimeEnvironmentId ? undefined : 'local')
    if (shouldApplyUpdate && !shouldApplyUpdate(existingWorktree)) {
      return { ok: true }
    }
    const mutationUpdates =
      updates.linkedItems === undefined
        ? updates
        : {
            ...updates,
            linkedItems: updates.linkedItems,
            linkedItemsBase: updates.linkedItemsBase ?? getWorkspaceAttachments(existingWorktree),
            linkedItemsSelectionChanged:
              updates.linkedItemsSelectionChanged ?? hasExplicitWorkspaceReviewSelection(updates)
          }
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      const folderUpdates = getFolderWorkspaceMetaUpdates(mutationUpdates)
      if (Object.keys(folderUpdates).length === 0) {
        return { ok: true }
      }
      try {
        // Rejected folder updates revert optimistic state; report failure or the dialog closes on an undone save.
        const updated = await get().updateFolderWorkspace(
          workspaceScope.folderWorkspaceId,
          folderUpdates,
          { executionHostId }
        )
        return updated
          ? { ok: true }
          : {
              ok: false,
              error: translate(
                'auto.store.slices.worktrees.a17f4d2e93',
                'Could not update this workspace.'
              )
            }
      } catch (err) {
        console.error('Failed to update folder workspace meta:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    let normalizedUpdates = normalizeWorkspaceAttachmentUpdate(existingWorktree, mutationUpdates)
    // Why: manual PR linking supplies only the number; resolve the head branch so Push targets the review branch.
    const linkedPrForPushTarget = isPositiveHostedReviewNumber(normalizedUpdates.linkedPR)
      ? normalizedUpdates.linkedPR
      : null
    // Why: an ambiguous owner must not throw past this update's { ok, error } contract — skip the lookup instead.
    const pushTargetOwner =
      linkedPrForPushTarget !== null &&
      normalizedUpdates.pushTarget === undefined &&
      existingWorktree &&
      !existingWorktree.pushTarget
        ? runtimeTargetForWorkspaceOwner(get(), {
            workspaceId: worktreeId,
            ...(executionHostId ? { hostId: executionHostId } : {})
          })
        : null
    const resolvedPushTarget =
      pushTargetOwner && existingWorktree && linkedPrForPushTarget !== null
        ? await resolveGitHubReviewPushTarget(
            pushTargetOwner,
            existingWorktree.repoId,
            linkedPrForPushTarget
          )
        : undefined
    const worktreeForUpdate = get().getKnownWorktreeById(worktreeId, executionHostId)
    if (shouldApplyUpdate && !shouldApplyUpdate(worktreeForUpdate)) {
      return { ok: true }
    }
    normalizedUpdates = normalizeGitHubPRSuppressionUpdate(
      normalizeWorkspaceAttachmentUpdate(worktreeForUpdate, mutationUpdates)
    )
    const currentResolvedPushTarget =
      normalizedUpdates.linkedPR === linkedPrForPushTarget ? resolvedPushTarget : undefined
    const existingHostedReviewPushTargetLookup = worktreeForUpdate
      ? getHostedReviewPushTargetLookup(worktreeForUpdate)
      : null
    const nextHostedReviewPushTargetLookup = worktreeForUpdate
      ? getHostedReviewPushTargetLookup({ ...worktreeForUpdate, ...normalizedUpdates })
      : null
    // A lookup can finish after another editor changes the selected review.
    const shouldClearStaleHostedReviewPushTarget =
      Boolean(worktreeForUpdate?.pushTarget) &&
      normalizedUpdates.pushTarget === undefined &&
      currentResolvedPushTarget === undefined &&
      existingHostedReviewPushTargetLookup !== null &&
      existingHostedReviewPushTargetLookup.key !== nextHostedReviewPushTargetLookup?.key
    const shouldRefreshHostedReview = Boolean(
      worktreeForUpdate && hasChangedHostedReviewLinkUpdates(normalizedUpdates, worktreeForUpdate)
    )
    const reviewRepo = shouldRefreshHostedReview
      ? (findRepoForHost(get().repos, worktreeForUpdate?.repoId ?? '', {
          hostId: executionHostId,
          settings: get().settings
        }) ?? undefined)
      : undefined
    const reviewBranch = worktreeForUpdate?.branch.replace(/^refs\/heads\//, '')

    // Why: bump lastActivityAt on comment edits so the time-decay sort doesn't drop a just-touched worktree.
    const displayNameProvenance =
      'displayName' in normalizedUpdates
        ? { displayNameIsPinned: displayNameUpdatePinsLabel(normalizedUpdates.displayName) }
        : {}
    const targetEnriched = currentResolvedPushTarget
      ? { ...normalizedUpdates, ...displayNameProvenance, pushTarget: currentResolvedPushTarget }
      : shouldClearStaleHostedReviewPushTarget
        ? { ...normalizedUpdates, ...displayNameProvenance, pushTarget: undefined }
        : { ...normalizedUpdates, ...displayNameProvenance }
    const renameCleared =
      'displayName' in targetEnriched
        ? {
            ...targetEnriched,
            pendingFirstAgentMessageRename: false,
            firstAgentMessageRenameError: null
          }
        : targetEnriched
    // Switch point: a comment edit is not a Recent event once the host owns the stamps.
    const enriched =
      'comment' in renameCleared && !ORCA_SIDEBAR_INPUTS_IS_MAIN
        ? { ...renameCleared, lastActivityAt: Date.now() }
        : renameCleared

    // A failed save must leave the error visible even when the recovery fetch also fails.
    const deferUpdate =
      mutationUpdates.firstAgentMessageRenameError === null &&
      mutationUpdates.displayName === undefined
    let didApply = false
    const buildUpdate = (s: ReturnType<WorktreeSliceGet>) => {
      if (
        shouldApplyUpdate &&
        !shouldApplyUpdate(findKnownWorktreeById(s, worktreeId, executionHostId))
      ) {
        return s
      }
      didApply = true
      return buildWorktreeMetaStateUpdate(s, {
        worktreeId,
        updates: enriched,
        executionHostId,
        reviewRepo,
        reviewBranch
      })
    }
    if (!deferUpdate) {
      set(buildUpdate)
    }
    if (!deferUpdate && shouldApplyUpdate && !didApply) {
      return { ok: true }
    }
    if (hasHostedReviewLinkUpdates(enriched)) {
      bumpHostedReviewLinkMutationGeneration(worktreeId, worktreeForUpdate)
    }

    try {
      await persistWorktreeMeta(
        runtimeTargetForWorktreeOwner(get(), worktreeId, executionHostId),
        worktreeId,
        getWorkspaceReviewPersistenceUpdates(mutationUpdates, enriched),
        executionHostId ?? existingWorktree?.hostId,
        worktreeForUpdate?.identity?.key
      )
      if (deferUpdate) {
        set(buildUpdate)
      }
      if (
        !options?.suppressHostedReviewRefresh &&
        reviewRepo &&
        reviewBranch &&
        typeof get().fetchHostedReviewForBranch === 'function'
      ) {
        // Why: refetch against post-update links so a cache entry from the previous provider link can't keep showing the removed review.
        void get().fetchHostedReviewForBranch(reviewRepo.path, reviewBranch, {
          repoId: reviewRepo.id,
          repoOwnerExecutionHostId: executionHostId ?? worktreeForUpdate?.hostId,
          ...getWorkspaceReviewRefreshHints(targetEnriched, worktreeForUpdate),
          force: true
        })
      }
    } catch (err) {
      if (isRuntimeSelectorNotFoundError(err)) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        return {
          ok: false,
          error: translate(
            'auto.store.slices.worktrees.c6cf133786',
            'This workspace is no longer available.'
          )
        }
      }
      console.error('Failed to update worktree meta:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      // Refetch reverted the optimistic write; report failure so callers do not close on an undone save.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true }
  }
  // A conditional write may not apply, so only an unconditional one shows ahead of main.
  return (worktreeId, updates, options) =>
    options?.shouldApply
      ? update(worktreeId, updates, options)
      : withPendingSidebarRowWrites(
          () => [
            {
              worktreeId,
              updates,
              executionHostId:
                options?.executionHostId ?? findKnownWorktreeById(get(), worktreeId)?.hostId
            }
          ],
          () => update(worktreeId, updates, options)
        )
}
