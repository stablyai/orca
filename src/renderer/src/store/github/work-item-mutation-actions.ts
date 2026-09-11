import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { toast } from 'sonner'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import type { CacheEntry } from './cache-model'
import { evictRepoCacheEntries, repoCacheKeyPrefixes } from './cache-identity'
import { ERROR_TOAST_DURATION } from './cache-policy'
import { clearInflightWorkItemsForRepo } from './request-coordination'

export const createWorkItemMutationActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'patchWorkItem' | 'setIssueSourcePreference' | 'evictGitHubRepoCaches'> => ({
  patchWorkItem: (itemId, patch, repoId, options) => {
    set((s) => {
      const nextCache = { ...s.workItemsCache }
      let changed = false
      const sourceScope =
        options?.sourceContext?.provider === 'github'
          ? getTaskSourceCacheScope(options.sourceContext)
          : null
      for (const key of Object.keys(nextCache)) {
        // Why: don't patch another host/account's visually identical issue/PR cache entry.
        if (sourceScope && key !== sourceScope && !key.startsWith(`${sourceScope}::`)) {
          continue
        }
        const entry = nextCache[key]
        if (!entry?.data) {
          continue
        }
        // Why: issue/PR ids are only unique within a repo; cross-repo views can share `pr:42`.
        const idx = entry.data.findIndex(
          (item) => item.id === itemId && (!repoId || item.repoId === repoId)
        )
        if (idx === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        updatedItems[idx] = { ...updatedItems[idx], ...patch }
        nextCache[key] = { ...entry, data: updatedItems }
        changed = true
      }
      return changed ? { workItemsCache: nextCache } : {}
    })
  },

  setIssueSourcePreference: async (repoId, repoPath, preference) => {
    // Why: optimistically patch the local Repo so the segmented control updates this frame; resync via fetchRepos on IPC failure.
    set((s) => ({
      repos: s.repos.map((r) =>
        r.id === repoId
          ? {
              ...r,
              issueSourcePreference: preference === 'auto' ? undefined : preference
            }
          : r
      )
    }))
    try {
      // Why: use the generic `repos:update` channel so a single write → single `repos:changed` broadcast re-fetches other windows.
      // Why: map 'auto' to undefined so persistence drops the key entirely (see main/persistence.ts#updateRepo).
      const updates = { issueSourcePreference: preference === 'auto' ? undefined : preference }
      // Why: route to the repo's owner host (like updateRepo) so the write lands where the repo lives, not the focused runtime.
      const target = getActiveRuntimeTarget(getSettingsForRepoRuntimeOwner(get(), repoId))
      await (target.kind === 'local'
        ? window.api.repos.update({ repoId, updates })
        : callRuntimeRpc(target, 'repo.update', { repo: repoId, updates }, { timeoutMs: 15_000 }))
    } catch (err) {
      console.error('Failed to persist issue-source preference:', err)
      // Why: without this toast the pill silently snaps back (optimistic patch + resync) and the user wouldn't know the write failed.
      toast.error(
        translate('auto.store.slices.github.d49ef4b944', 'Failed to save issue-source preference'),
        {
          duration: ERROR_TOAST_DURATION
        }
      )
      // Why: the optimistic patch may now disagree with disk; resync rather than leave a lie on screen.
      void get().fetchRepos()
    }
    // Why: clear inflight dedupe BEFORE bumping the nonce so the re-triggered fetch can't collapse onto a pre-flip in-flight entry.
    clearInflightWorkItemsForRepo(repoId, repoPath)
    // Why: evict AFTER the await so an overlapping fetch can't repopulate with pre-flip data; also drops legacy path-scoped keys.
    set((s) => {
      const prefix = `${repoId}::`
      const legacyPrefix = `${repoPath}::`
      const next: Record<string, CacheEntry<readonly GitHubWorkItem[]>> = {}
      for (const [key, entry] of Object.entries(s.workItemsCache)) {
        if (!key.startsWith(prefix) && !key.startsWith(legacyPrefix)) {
          next[key] = entry
        }
      }
      // Why: the Tasks fetch effect keys on the nonce, not the cache, so bump it to re-run and re-populate the evicted entries.
      return { workItemsCache: next, workItemsInvalidationNonce: s.workItemsInvalidationNonce + 1 }
    })
  },

  evictGitHubRepoCaches: (repoId, repoPath) => {
    clearInflightWorkItemsForRepo(repoId, repoPath)
    set((s) => {
      const prefixes = repoCacheKeyPrefixes(repoId, repoPath)
      const workItems = evictRepoCacheEntries(s.workItemsCache, prefixes)
      const prs = evictRepoCacheEntries(s.prCache, prefixes)
      const issues = evictRepoCacheEntries(s.issueCache, prefixes)
      const checks = evictRepoCacheEntries(s.checksCache, prefixes)
      const comments = evictRepoCacheEntries(s.commentsCache, prefixes)
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
