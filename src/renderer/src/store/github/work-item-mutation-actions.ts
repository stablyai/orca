import { markGitHubTaskListWrites, markGitHubTaskDeliveryWrites } from './task-read-reconciliation'
import {
  batchTaskPageGitHubMutationRegistry,
  observeExistingListBase
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import type { StateCreator } from 'zustand'

import type { AppState } from '../types'

import type { GitHubSlice } from './slice-types'

import { toast } from 'sonner'

import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

import { translate } from '@/i18n/i18n'

import { repoMatchesHostIdentity } from '../slices/repo-host-identity'

import { evictRepoCacheEntries, repoCacheEviction, type RepoCacheEviction } from './cache-identity'

import { ERROR_TOAST_DURATION } from './cache-policy'

import { clearInflightWorkItemsForRepo } from './request-coordination'

import { findRepoForGitHubOwner } from './repository-routing'

// Why: the row's own host is the bucket to drop; a same-id twin on another host keeps its own.
function repoCacheEvictionForRow(
  state: AppState,
  repoId: string,
  repoPath: string | undefined,
  hostId?: ExecutionHostId
): RepoCacheEviction {
  const row = hostId ? undefined : findRepoForGitHubOwner(state, repoId, repoPath ?? '')
  const evictedHostId = hostId ?? (row ? getRepoExecutionHostId(row) : null)
  return repoCacheEviction(state.repos, repoId, repoPath, evictedHostId)
}

export const createWorkItemMutationActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  GitHubSlice,
  'patchWorkItem' | 'patchWorkItems' | 'setIssueSourcePreference' | 'evictGitHubRepoCaches'
> => ({
  patchWorkItems: (patches) =>
    batchTaskPageGitHubMutationRegistry(() => {
      const prepared = prepareWorkItemPatches(get(), patches, true)
      for (const { address, input } of prepared.existingEntryBaseObservations) {
        observeExistingListBase(address, input, true)
      }
      set(prepared.storePatch)
      markGitHubTaskDeliveryWrites(prepared.deliveryWrites)
      markGitHubTaskListWrites(patches.flatMap((request) => request.options?.listComposition ?? []))
    }),
  patchWorkItem: (itemId, patch, repoId, options) =>
    batchTaskPageGitHubMutationRegistry(() => {
      const prepared = prepareWorkItemPatches(get(), [{ itemId, patch, repoId, options }], false)
      for (const { address, input } of prepared.existingEntryBaseObservations) {
        observeExistingListBase(address, input, true)
      }
      set(prepared.storePatch)
      markGitHubTaskDeliveryWrites(prepared.deliveryWrites)
      markGitHubTaskListWrites(options?.listComposition ?? [])
    }),

  setIssueSourcePreference: async (repoId, repoPath, preference, hostId) => {
    // Why: map 'auto' to undefined so persistence drops the key entirely (see main/persistence.ts#updateRepo).
    const issueSourcePreference = preference === 'auto' ? undefined : preference
    // Why: optimistically patch the row so the segmented control updates this frame; a twin's other row keeps its own.
    set((s) => ({
      repos: s.repos.map((r) =>
        repoMatchesHostIdentity(r, repoId, hostId) ? { ...r, issueSourcePreference } : r
      )
    }))
    // Why: updateRepo routes by the row's host, so a twin's write lands on the row the user changed.
    const saved = await get().updateRepo(repoId, { issueSourcePreference }, { hostId })
    if (!saved) {
      // Why: without this toast the pill silently snaps back (optimistic patch + resync) and the user wouldn't know the write failed.
      toast.error(
        translate('auto.store.slices.github.d49ef4b944', 'Failed to save issue-source preference'),
        {
          duration: ERROR_TOAST_DURATION
        }
      )
      // Why: the optimistic patch may now disagree with disk; resync rather than leave a lie on screen.
      void get().fetchReposForAllHosts()
    }
    const eviction = repoCacheEvictionForRow(get(), repoId, repoPath, hostId)
    // Why: clear inflight dedupe BEFORE bumping the nonce so the re-triggered fetch can't collapse onto a pre-flip in-flight entry.
    clearInflightWorkItemsForRepo(eviction)
    // Why: evict AFTER the await so an overlapping fetch can't repopulate with pre-flip data; also drops legacy path-scoped keys.
    set((s) => ({
      workItemsCache: evictRepoCacheEntries(s.workItemsCache, eviction).cache,
      // Why: the Tasks fetch effect keys on the nonce, not the cache, so bump it to re-run and re-populate the evicted entries.
      workItemsInvalidationNonce: s.workItemsInvalidationNonce + 1
    }))
  },

  evictGitHubRepoCaches: (repoId, repoPath, hostId) => {
    const eviction = repoCacheEvictionForRow(get(), repoId, repoPath, hostId)
    clearInflightWorkItemsForRepo(eviction)
    set((s) => {
      const workItems = evictRepoCacheEntries(s.workItemsCache, eviction)
      const prs = evictRepoCacheEntries(s.prCache, eviction)
      const issues = evictRepoCacheEntries(s.issueCache, eviction)
      const checks = evictRepoCacheEntries(s.checksCache, eviction)
      const comments = evictRepoCacheEntries(s.commentsCache, eviction)
      const updates: Partial<AppState> = {}

      if (workItems.evicted) {
        updates.workItemsCache = workItems.cache
        updates.workItemsInvalidationNonce = s.workItemsInvalidationNonce + 1
      }
      if (prs.evicted) {
        updates.prCache = prs.cache
      }
      if (issues.evicted) {
        updates.issueCache = issues.cache
      }
      if (checks.evicted) {
        updates.checksCache = checks.cache
      }
      if (comments.evicted) {
        updates.commentsCache = comments.cache
      }

      return updates
    })
  }
})
import { prepareWorkItemPatches } from './work-item-cache-patches'
