import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { rightSidebarShowsPullRequestData } from '@/lib/right-sidebar-visibility'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { issueCacheKey, prCacheKey } from './cache-identity'
import { CACHE_TTL, evictStaleEntries } from './cache-policy'
import { pruneExpiredPRRefreshStates } from './pr-refresh-state'
import {
  enqueueLocalGitHubPRRefresh,
  getPRRefreshRuntimeRepoTarget,
  getRuntimeRepoTarget,
  shouldEnqueueLocalPRRefresh
} from './repository-routing'
import { settingsForGitHubRepoOwner } from './work-item-routing'
import { buildPRRefreshCandidate } from './worktree-refresh'

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

    // Only re-fetch PR/issue entries that are already stale — skip fresh ones
    const state = get()
    const cardProps = state.worktreeCardProperties ?? []
    const rawCardProps = cardProps as readonly string[]
    const shouldRefreshIssues = (state.worktreeCardProperties ?? []).includes('issue')
    const isPRStatusGrouping = state.groupBy === 'pr-status'
    const rightSidebarShowsPR = rightSidebarShowsPullRequestData(state)
    const shouldRefreshPRs =
      isPRStatusGrouping ||
      rightSidebarShowsPR ||
      (state.settings?.experimentalNewWorktreeCardStyle === true
        ? cardProps.includes('status')
        : cardProps.includes('pr') || rawCardProps.includes('ci'))
    if (!shouldRefreshPRs && !shouldRefreshIssues) {
      return
    }

    const now = Date.now()
    const stalePRCandidates: { candidate: GitHubPRRefreshCandidate; score: number }[] = []
    const repoLookup = getGitHubRepoLookupIndex(state.repos)

    for (const worktrees of Object.values(state.worktreesByRepo)) {
      for (const wt of worktrees) {
        const repo = repoLookup.findById(wt.repoId)
        if (!repo) {
          continue
        }

        const branch = wt.branch.replace(/^refs\/heads\//, '')
        if (shouldRefreshPRs && !wt.isBare && branch) {
          const ownerSettings = settingsForGitHubRepoOwner(state.settings, repo)
          const prKey = prCacheKey(
            repo.path,
            repo.id,
            branch,
            ownerSettings,
            repo.connectionId,
            repo.executionHostId
          )
          const prEntry = state.prCache[prKey]
          if (!prEntry || now - prEntry.fetchedAt >= CACHE_TTL) {
            const candidate = buildPRRefreshCandidate(state, wt, undefined, repo)
            if (candidate) {
              stalePRCandidates.push({
                candidate,
                score:
                  (state.activeWorktreeId === wt.id ? Number.MAX_SAFE_INTEGER : 0) +
                  wt.lastActivityAt
              })
            }
          }
        }
        if (shouldRefreshIssues && wt.linkedIssue) {
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
    const candidatesToRefresh = stalePRCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, isPRStatusGrouping ? stalePRCandidates.length : 5)
    for (const { candidate } of candidatesToRefresh) {
      const candidateSettings = settingsForGitHubRepoOwner(
        state.settings,
        candidate as Pick<Repo, 'connectionId' | 'executionHostId'>
      )
      if (getRuntimeRepoTarget(state, candidate.repoPath, candidateSettings)) {
        void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
          repoId: candidate.repoId,
          worktreeId: candidate.worktreeId,
          linkedPRNumber: candidate.linkedPRNumber ?? null,
          fallbackPRNumber: candidate.fallbackPRNumber ?? null,
          fallbackPRSource: candidate.fallbackPRSource ?? null,
          reason: 'swr'
        })
      } else if (shouldEnqueueLocalPRRefresh(candidate)) {
        enqueueLocalGitHubPRRefresh({ candidate, reason: 'swr', priority: 10 })
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

    // Re-fetch (skip when branch is empty — detached HEAD during rebase)
    if (!worktree.isBare && branch) {
      const candidate = buildPRRefreshCandidate(get(), worktree)
      if (candidate) {
        if (getPRRefreshRuntimeRepoTarget(get(), candidate)) {
          void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
            force: true,
            repoId: candidate.repoId,
            worktreeId: candidate.worktreeId,
            linkedPRNumber: candidate.linkedPRNumber ?? null,
            fallbackPRNumber: candidate.fallbackPRNumber ?? null,
            fallbackPRSource: candidate.fallbackPRSource ?? null,
            reason: 'post-push'
          })
        } else if (shouldEnqueueLocalPRRefresh(candidate)) {
          enqueueLocalGitHubPRRefresh({ candidate, reason: 'post-push', priority: 100 })
        }
      }
    }
    if ((state.worktreeCardProperties ?? []).includes('issue') && worktree.linkedIssue) {
      void get().fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
    }
  }
})
