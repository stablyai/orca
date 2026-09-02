import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { rightSidebarShowsPullRequestData } from '@/lib/right-sidebar-visibility'
import { issueCacheKey } from './cache-identity'
import { CACHE_TTL } from './cache-policy'
import {
  enqueueLocalGitHubPRRefresh,
  getPRRefreshRuntimeRepoTarget,
  shouldEnqueueLocalPRRefresh
} from './repository-routing'
import { settingsForGitHubRepoOwner } from './work-item-routing'
import { buildPRRefreshCandidate } from './worktree-refresh'

export const createStaleWorktreeRefreshActions = (
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'refreshGitHubForWorktreeIfStale'> => ({
  // Why: activation is the strongest freshness signal; route through the coordinator to keep coalescing/rate-limit guards.
  refreshGitHubForWorktreeIfStale: (worktreeId) => {
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

    const now = Date.now()
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const cardProps = state.worktreeCardProperties ?? []
    const rawCardProps = cardProps as readonly string[]
    const shouldRefreshPR =
      state.groupBy === 'pr-status' ||
      (state.settings?.experimentalNewWorktreeCardStyle === true
        ? cardProps.includes('status')
        : cardProps.includes('pr') || rawCardProps.includes('ci')) ||
      rightSidebarShowsPullRequestData(state)

    if (shouldRefreshPR && !worktree.isBare && branch) {
      const candidate = buildPRRefreshCandidate(state, worktree)
      if (candidate) {
        if (getPRRefreshRuntimeRepoTarget(state, candidate)) {
          void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
            force: true,
            repoId: candidate.repoId,
            worktreeId: candidate.worktreeId,
            linkedPRNumber: candidate.linkedPRNumber ?? null,
            fallbackPRNumber: candidate.fallbackPRNumber ?? null,
            fallbackPRSource: candidate.fallbackPRSource ?? null,
            reason: 'active'
          })
        } else if (shouldEnqueueLocalPRRefresh(candidate)) {
          enqueueLocalGitHubPRRefresh({ candidate, reason: 'active', priority: 80 })
        }
      }
    }

    if ((state.worktreeCardProperties ?? []).includes('issue') && worktree.linkedIssue) {
      const ownerSettings = settingsForGitHubRepoOwner(state.settings, repo)
      const issueKey = issueCacheKey(
        repo.path,
        repo.id,
        worktree.linkedIssue,
        ownerSettings,
        repo.connectionId,
        repo.executionHostId,
        true
      )
      const issueEntry = state.issueCache[issueKey]
      if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
        void get().fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
      }
    }
  }
})
