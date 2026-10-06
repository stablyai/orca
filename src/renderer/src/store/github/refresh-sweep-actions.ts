import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeGitHubIssueRepository } from '../../../../shared/worktree/github-issue-repository'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { issueCacheKey, prCacheKey } from './cache-identity'
import { CACHE_TTL, evictStaleEntries } from './cache-policy'
import { pruneExpiredPRRefreshStates } from './pr-refresh-state'
import { settingsForGitHubRepoOwner } from './work-item-routing'

export const createRefreshSweepActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'refreshAllGitHub' | 'refreshGitHubForWorktree'> => ({
  refreshAllGitHub: () => {
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
      // Why: each eviction helper returns its input untouched when nothing changed, so an
      // unchanged sweep can return `s` and avoid waking every subscriber on window resume.
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

    for (const worktrees of Object.values(state.worktreesByRepo)) {
      for (const wt of worktrees) {
        const repo = repoLookup.findById(wt.repoId)
        if (!repo) {
          continue
        }

        if (wt.linkedIssue) {
          const ownerRepo = getWorktreeGitHubIssueRepository(wt)
          const ownerSettings = settingsForGitHubRepoOwner(state.settings, repo)
          const issueKey = issueCacheKey(
            repo.path,
            repo.id,
            wt.linkedIssue,
            ownerSettings,
            repo.connectionId,
            repo.executionHostId,
            true,
            ownerRepo
          )
          const issueEntry = state.issueCache[issueKey]
          if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
            void get().fetchIssue(repo.path, wt.linkedIssue, {
              repoId: repo.id,
              ...(ownerRepo ? { ownerRepo } : {})
            })
          }
        }
      }
    }
  },

  refreshGitHubForWorktree: (worktreeId) => {
    const state = get()
    let worktree: Worktree | undefined
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree) {
        break
      }
    }
    if (!worktree) {
      return
    }

    const repo = state.repos.find((r) => r.id === worktree.repoId)
    if (!repo) {
      return
    }

    // Invalidate this worktree's cache entries
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const ownerSettings = settingsForGitHubRepoOwner(state.settings, repo)
    const ownerRepo = getWorktreeGitHubIssueRepository(worktree)
    const prKey = prCacheKey(
      repo.path,
      repo.id,
      branch,
      ownerSettings,
      repo.connectionId,
      repo.executionHostId
    )
    const issueKey = worktree.linkedIssue
      ? issueCacheKey(
          repo.path,
          repo.id,
          worktree.linkedIssue,
          ownerSettings,
          repo.connectionId,
          repo.executionHostId,
          true,
          ownerRepo
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

    // Re-fetch (skip when branch is empty — detached HEAD during rebase)
    if (!worktree.isBare && branch) {
      get().enqueueGitHubPRRefresh(worktreeId, 'post-push', 100)
    }
    if ((state.worktreeCardProperties ?? []).includes('issue') && worktree.linkedIssue) {
      void get().fetchIssue(repo.path, worktree.linkedIssue, {
        repoId: repo.id,
        ...(ownerRepo ? { ownerRepo } : {})
      })
    }
  }
})
