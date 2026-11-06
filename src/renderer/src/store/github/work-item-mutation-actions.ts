import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { toast } from 'sonner'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
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
): Pick<GitHubSlice, 'patchWorkItem' | 'setIssueSourcePreference' | 'evictGitHubRepoCaches'> => ({
  patchWorkItem: (itemId, patch, repoId, options) => {
    set((s) => {
      const nextCache = { ...s.workItemsCache }
      let changed = false
      const sourceScope =
        options?.sourceContext?.provider === 'github'
          ? getTaskSourceCacheScope(options.sourceContext)
          : null
      const repositoryKey = options?.ownerRepo ? githubRepoIdentityKey(options.ownerRepo) : null
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
        const idx = entry.data.findIndex((item) => {
          if (item.id !== itemId || (repoId && item.repoId !== repoId)) {
            return false
          }
          if (!repositoryKey) {
            return true
          }
          const itemRepository = parseGitHubIssueOrPRLink(item.url)?.slug
          return (
            itemRepository !== undefined && githubRepoIdentityKey(itemRepository) === repositoryKey
          )
        })
        if (idx === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        const row = updatedItems[idx]
        updatedItems[idx] = { ...row, ...(typeof patch === 'function' ? patch(row) : patch) }
        nextCache[key] = { ...entry, data: updatedItems }
        changed = true
      }
      return changed ? { workItemsCache: nextCache } : s
    })
  },

  setIssueSourcePreference: async (repoId, _repoPath, preference, hostId) => {
    const repo = get().repos.find((row) => repoMatchesHostIdentity(row, repoId, hostId))
    if (!repo) {
      return
    }
    const issueSourcePreference = preference === 'auto' ? undefined : preference
    const owner = get().githubSourceCollections
    const write = owner.begin(repo, issueSourcePreference)
    set((s) => ({
      repos: s.repos.map((row) =>
        repoMatchesHostIdentity(row, repoId, hostId) ? { ...row, issueSourcePreference } : row
      ),
      workItemsInvalidationNonce: s.workItemsInvalidationNonce + 1
    }))
    const saved = await get().updateRepo(repoId, { issueSourcePreference }, { hostId })
    owner.settle(write, saved)
    if (!saved) {
      toast.error(
        translate('auto.store.slices.github.d49ef4b944', 'Failed to save issue-source preference'),
        { duration: ERROR_TOAST_DURATION }
      )
    }
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
