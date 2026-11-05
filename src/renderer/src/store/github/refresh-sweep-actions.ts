import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { buildPRRefreshCandidate, findWorktreeReviewOwner } from './worktree-refresh'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { issueCacheKey } from './cache-identity'
import { CACHE_TTL, evictStaleEntries } from './cache-policy'
import { pruneExpiredPRRefreshStates } from './pr-refresh-state'
import { pruneExpiredPRRefreshStartedEntries } from './pr-result-cache'
import { settingsForGitHubRepoOwner } from './work-item-routing'
import { selectWorktreesByRepo } from '../workspace-record-selectors'

export const createRefreshSweepActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'refreshAllGitHub' | 'refreshGitHubForWorktree'> => ({
  refreshAllGitHub: () => {
    pruneExpiredPRRefreshStartedEntries()
    // Clear comments cache; evict stale entries to bound long-session growth across repos/branches.
    set((s) => {
      const next = {
        commentsCache: Object.keys(s.commentsCache).length === 0 ? s.commentsCache : {},
        prCache: evictStaleEntries(s.prCache),
        issueCache: evictStaleEntries(s.issueCache),
        checksCache: evictStaleEntries(s.checksCache),
        workItemsCache: evictStaleEntries(s.workItemsCache),
        projectViewCache: evictStaleEntries(s.projectViewCache),
        prRefreshStates: pruneExpiredPRRefreshStates(s.prRefreshStates)
      }
      // Unchanged eviction returns input maps; return s too so window-resume sweeps do not wake every subscriber.
      return next.commentsCache === s.commentsCache &&
        next.prCache === s.prCache &&
        next.issueCache === s.issueCache &&
        next.checksCache === s.checksCache &&
        next.workItemsCache === s.workItemsCache &&
        next.projectViewCache === s.projectViewCache &&
        next.prRefreshStates === s.prRefreshStates
        ? s
        : next
    })

    // Why: don't prune prRequestGenerations here — deleting a live generation makes its response look stale.

    const state = get()
    if (!(state.worktreeCardProperties ?? []).includes('issue')) {
      return
    }

    const now = Date.now()
    const repoLookup = getGitHubRepoLookupIndex(state.repos)

    for (const worktrees of Object.values(selectWorktreesByRepo(state))) {
      for (const wt of worktrees) {
        const repo = repoLookup.findById(wt.repoId)
        if (!repo) {
          continue
        }

        if (wt.linkedIssue) {
          const ownerSettings = settingsForGitHubRepoOwner(state.settings, repo)
          const issueKey = issueCacheKey(
            repo.path,
            repo.id,
            wt.linkedIssue,
            ownerSettings,
            repo.connectionId,
            repo.executionHostId,
            true
          )
          const issueEntry = state.issueCache[issueKey]
          if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
            void get().fetchIssue(repo.path, wt.linkedIssue, { repoId: repo.id })
          }
        }
      }
    }
  },

  refreshGitHubForWorktree: (worktreeId, executionHostId) => {
    const state = get()
    const owner = findWorktreeReviewOwner(state, worktreeId, executionHostId)
    if (!owner) {
      return
    }
    const { worktree, repo } = owner
    const candidate = buildPRRefreshCandidate(state, worktree, undefined, repo)
    if (!candidate) {
      return
    }
    const ownerHostId = getRepoExecutionHostId(candidate)

    const branch = candidate.branch
    const ownerSettings = settingsForGitHubRepoOwner(state.settings, repo)
    const prKey = candidate.cacheKey
    const issueKey = worktree.linkedIssue
      ? issueCacheKey(
          repo.path,
          repo.id,
          worktree.linkedIssue,
          ownerSettings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''

    set((s) => {
      const updates: Partial<AppState> = {}
      if (s.prCache[prKey]) {
        updates.prCache = { ...s.prCache, [prKey]: { ...s.prCache[prKey], fetchedAt: 0 } }
      }
      if (issueKey && s.issueCache[issueKey]) {
        updates.issueCache = {
          ...s.issueCache,
          [issueKey]: { ...s.issueCache[issueKey], fetchedAt: 0 }
        }
      }
      return updates
    })

    if (!worktree.isBare && branch) {
      get().enqueueGitHubPRRefresh(worktreeId, 'post-push', 100, ownerHostId)
    }
    if ((state.worktreeCardProperties ?? []).includes('issue') && worktree.linkedIssue) {
      void get().fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
    }
  }
})
