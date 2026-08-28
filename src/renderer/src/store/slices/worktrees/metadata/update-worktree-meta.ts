import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { translate } from '@/i18n/i18n'
import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { applyWorktreeUpdates, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { getHostedReviewCacheKey } from '../../hosted-review-cache-identity'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from '../../github-cache-key'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById,
  getFolderWorkspaceMetaUpdates
} from '../listing/detected-worktree-meta'
import {
  bumpHostedReviewLinkMutationGeneration,
  clearOlderHostedReviewLinksForReplacement,
  getHostedReviewLinkForMetaRefresh,
  hasHostedReviewLinkUpdates
} from './hosted-review-link-mutation'
import {
  getHostedReviewPushTargetLookup,
  resolveGitHubReviewPushTarget
} from './hosted-review-push-target'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import {
  settingsForWorktreeOwner,
  trySettingsForWorktreeOwner
} from '../listing/worktree-owner-settings'

import { findRepoForHost } from '../../repo-host-identity'
export function createUpdateWorktreeMeta(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeMeta'] {
  return async (worktreeId, updates, options) => {
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
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      const folderUpdates = getFolderWorkspaceMetaUpdates(updates)
      if (Object.keys(folderUpdates).length === 0) {
        return { ok: true }
      }
      try {
        // Why: a rejected folder update reconciles the optimistic write away, so
        // reporting ok would show the dialog a save that silently undid itself.
        const updated = await get().updateFolderWorkspace(
          workspaceScope.folderWorkspaceId,
          folderUpdates
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
    const normalizedUpdates = existingWorktree
      ? clearOlderHostedReviewLinksForReplacement(updates, existingWorktree)
      : updates
    // Why: manual PR linking supplies only the number; resolve the head branch so Push targets the review branch.
    const linkedPrForPushTarget = isPositiveHostedReviewNumber(normalizedUpdates.linkedPR)
      ? normalizedUpdates.linkedPR
      : null
    // Why: an ambiguous owner must not throw past this update's { ok, error } contract — skip the lookup instead.
    const pushTargetOwnerSettings =
      linkedPrForPushTarget !== null &&
      normalizedUpdates.pushTarget === undefined &&
      existingWorktree &&
      !existingWorktree.pushTarget
        ? trySettingsForWorktreeOwner(get(), worktreeId, executionHostId)
        : null
    const resolvedPushTarget =
      pushTargetOwnerSettings && existingWorktree && linkedPrForPushTarget !== null
        ? await resolveGitHubReviewPushTarget(
            pushTargetOwnerSettings,
            existingWorktree.repoId,
            linkedPrForPushTarget
          )
        : undefined
    const existingHostedReviewPushTargetLookup = existingWorktree
      ? getHostedReviewPushTargetLookup(existingWorktree)
      : null
    const nextHostedReviewPushTargetLookup = existingWorktree
      ? getHostedReviewPushTargetLookup({ ...existingWorktree, ...normalizedUpdates })
      : null
    // Why: a pushTarget derived from a linked review must not keep steering pushes after it's unlinked or replaced.
    const shouldClearStaleHostedReviewPushTarget =
      Boolean(existingWorktree?.pushTarget) &&
      normalizedUpdates.pushTarget === undefined &&
      resolvedPushTarget === undefined &&
      existingHostedReviewPushTargetLookup !== null &&
      existingHostedReviewPushTargetLookup.key !== nextHostedReviewPushTargetLookup?.key
    const worktreeForUpdate = get().getKnownWorktreeById(worktreeId, executionHostId)
    if (shouldApplyUpdate && !shouldApplyUpdate(worktreeForUpdate)) {
      return { ok: true }
    }
    const shouldRefreshHostedReview =
      (normalizedUpdates.linkedPR === null && (worktreeForUpdate?.linkedPR ?? null) !== null) ||
      (normalizedUpdates.linkedGitLabMR === null &&
        (worktreeForUpdate?.linkedGitLabMR ?? null) !== null) ||
      (normalizedUpdates.linkedBitbucketPR === null &&
        (worktreeForUpdate?.linkedBitbucketPR ?? null) !== null) ||
      (normalizedUpdates.linkedAzureDevOpsPR === null &&
        (worktreeForUpdate?.linkedAzureDevOpsPR ?? null) !== null) ||
      (normalizedUpdates.linkedGiteaPR === null &&
        (worktreeForUpdate?.linkedGiteaPR ?? null) !== null)
    const reviewRepo = shouldRefreshHostedReview
      ? (findRepoForHost(get().repos, worktreeForUpdate?.repoId ?? '', {
          hostId: executionHostId,
          settings: get().settings
        }) ?? undefined)
      : undefined
    const reviewBranch = worktreeForUpdate?.branch.replace(/^refs\/heads\//, '')

    // Why: bump lastActivityAt on comment edits so the time-decay sort doesn't drop a just-touched worktree.
    const targetEnriched = resolvedPushTarget
      ? { ...normalizedUpdates, pushTarget: resolvedPushTarget }
      : shouldClearStaleHostedReviewPushTarget
        ? { ...normalizedUpdates, pushTarget: undefined }
        : normalizedUpdates
    const renameCleared =
      'displayName' in targetEnriched
        ? {
            ...targetEnriched,
            pendingFirstAgentMessageRename: false,
            firstAgentMessageRenameError: null
          }
        : targetEnriched
    const enriched =
      'comment' in renameCleared ? { ...renameCleared, lastActivityAt: Date.now() } : renameCleared

    let didApply = false
    set((s) => {
      if (
        shouldApplyUpdate &&
        !shouldApplyUpdate(findKnownWorktreeById(s, worktreeId, executionHostId))
      ) {
        return {}
      }
      didApply = true
      const nextWorktrees = applyWorktreeUpdates(
        s.worktreesByRepo,
        worktreeId,
        enriched,
        executionHostId
      )
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        enriched,
        executionHostId
      )
      const cacheKey =
        reviewRepo && reviewBranch
          ? getHostedReviewCacheKey(
              reviewRepo.path,
              reviewBranch,
              s.settings,
              reviewRepo.id,
              reviewRepo.connectionId,
              reviewRepo.executionHostId,
              true
            )
          : null
      const prCacheKey =
        reviewRepo && reviewBranch
          ? getGitHubPRCacheKey(
              reviewRepo.path,
              reviewRepo.id,
              reviewBranch,
              s.settings,
              reviewRepo.connectionId,
              reviewRepo.executionHostId,
              true
            )
          : null
      const prCacheKeys =
        reviewRepo && reviewBranch
          ? [
              prCacheKey,
              getLegacyGitHubPRCacheKey(reviewRepo.path, reviewRepo.id, reviewBranch),
              getLegacyGitHubPRCacheKey(reviewRepo.path, undefined, reviewBranch)
            ].filter((key): key is string => Boolean(key))
          : []
      const hostedReviewCache = s.hostedReviewCache ?? {}
      const prCache = s.prCache ?? {}
      if (
        nextWorktrees === s.worktreesByRepo &&
        nextDetectedWorktrees === s.detectedWorktreesByRepo &&
        !cacheKey &&
        !prCacheKey
      ) {
        return {}
      }

      const nextHostedReviewCache =
        cacheKey && hostedReviewCache[cacheKey]
          ? (() => {
              const next = { ...hostedReviewCache }
              delete next[cacheKey]
              return next
            })()
          : hostedReviewCache
      const nextPRCache = prCacheKeys.some((key) => prCache[key])
        ? (() => {
            const next = { ...prCache }
            for (const key of prCacheKeys) {
              delete next[key]
            }
            return next
          })()
        : prCache

      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {}),
        ...(nextHostedReviewCache !== hostedReviewCache
          ? { hostedReviewCache: nextHostedReviewCache }
          : {}),
        ...(nextPRCache !== prCache ? { prCache: nextPRCache } : {})
      }
    })
    if (shouldApplyUpdate && !didApply) {
      return { ok: true }
    }
    if (hasHostedReviewLinkUpdates(enriched)) {
      bumpHostedReviewLinkMutationGeneration(worktreeId)
    }

    try {
      await persistWorktreeMeta(
        settingsForWorktreeOwner(get(), worktreeId, executionHostId),
        worktreeId,
        enriched,
        executionHostId ?? existingWorktree?.hostId,
        worktreeForUpdate?.identity?.key
      )
      if (
        !options?.suppressHostedReviewRefresh &&
        reviewRepo &&
        reviewBranch &&
        typeof get().fetchHostedReviewForBranch === 'function'
      ) {
        // Why: refetch against post-update links so a cache entry from the previous provider link can't keep showing the removed review.
        void get().fetchHostedReviewForBranch(reviewRepo.path, reviewBranch, {
          repoId: reviewRepo.id,
          linkedGitHubPR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedPR'
          ),
          linkedGitLabMR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedGitLabMR'
          ),
          linkedBitbucketPR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedBitbucketPR'
          ),
          linkedAzureDevOpsPR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedAzureDevOpsPR'
          ),
          linkedGiteaPR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedGiteaPR'
          ),
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
      // Why: the refetch above reverts the optimistic write, so a caller that
      // closes its surface on this path shows the user a save that undid itself.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true }
  }
}
