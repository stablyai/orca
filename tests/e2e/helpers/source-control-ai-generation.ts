import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import path from 'path'
export async function openSourceControl(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const state = window.__store?.getState()
    state?.setActiveWorktree(targetWorktreeId)
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('source-control')
  }, worktreeId)
  await expect
    .poll(
      () =>
        page.evaluate((targetWorktreeId) => {
          const state = window.__store?.getState()
          return (
            state?.activeWorktreeId === targetWorktreeId &&
            state.rightSidebarOpen &&
            state.rightSidebarTab === 'source-control'
          )
        }, worktreeId),
      { timeout: 5_000 }
    )
    .toBe(true)
}
export async function seedCreatePrComposer(page: Page): Promise<{
  primaryWorktreeId: string
  prWorktreeId: string
  prWorktreePath: string
  primaryBranch: string
}> {
  return page.evaluate(async () => {
    const store =
      window.__store ??
      (() => {
        throw new Error('window.__store is not available')
      })()

    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const prWorktree = worktrees.find(
      (entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary'
    )
    const primaryWorktree = prWorktree
      ? worktrees.find(
          (entry) =>
            entry.repoId === prWorktree.repoId &&
            entry.id !== prWorktree.id &&
            !entry.branch.replace(/^refs\/heads\//, '').startsWith('e2e-')
        )
      : undefined
    if (!primaryWorktree || !prWorktree) {
      throw new Error('E2E fixture did not expose the expected main + secondary worktrees')
    }
    const repo =
      state.repos.find((entry) => entry.id === prWorktree.repoId) ??
      (() => {
        throw new Error('PR worktree repo not found')
      })()

    const branch = prWorktree.branch.replace(/^refs\/heads\//, '')
    const primaryBranch = primaryWorktree.branch.replace(/^refs\/heads\//, '')
    const eligibility = {
      provider: 'github' as const,
      review: null,
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      defaultBaseRef: primaryBranch,
      head: branch
    }

    store.setState((current) => ({
      repos: current.repos.map((candidate) =>
        candidate.id === repo.id ? { ...candidate, worktreeBaseRef: primaryBranch } : candidate
      ),
      gitStatusByWorktree: {
        ...current.gitStatusByWorktree,
        [primaryWorktree.id]: [],
        [prWorktree.id]: []
      },
      remoteStatusesByWorktree: {
        ...current.remoteStatusesByWorktree,
        [prWorktree.id]: {
          hasUpstream: true,
          upstreamName: `origin/${branch}`,
          ahead: 0,
          behind: 0
        }
      },
      getHostedReviewCreationEligibility: async (args) =>
        args.branch === branch ? eligibility : { ...eligibility, canCreate: false },
      fetchHostedReviewForBranch: async () => null,
      fetchPRForBranch: async () => null,
      fetchUpstreamStatus: async () => undefined,
      setUpstreamStatus: () => undefined
    }))

    return {
      primaryWorktreeId: primaryWorktree.id,
      prWorktreeId: prWorktree.id,
      prWorktreePath: prWorktree.path,
      primaryBranch
    }
  })
}

export async function seedCommitMessageComposer(page: Page): Promise<{
  primaryWorktreeId: string
  commitWorktreeId: string
  commitWorktreePath: string
}> {
  return page.evaluate(async () => {
    const store =
      window.__store ??
      (() => {
        throw new Error('window.__store is not available')
      })()

    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const commitWorktree = worktrees.find(
      (entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary'
    )
    const primaryWorktree = commitWorktree
      ? worktrees.find(
          (entry) =>
            entry.repoId === commitWorktree.repoId &&
            entry.id !== commitWorktree.id &&
            !entry.branch.replace(/^refs\/heads\//, '').startsWith('e2e-')
        )
      : undefined
    if (!primaryWorktree || !commitWorktree) {
      throw new Error('E2E fixture did not expose the expected main + secondary worktrees')
    }
    const primaryBranch = primaryWorktree.branch.replace(/^refs\/heads\//, '')

    store.setState((current) => ({
      gitStatusByWorktree: {
        ...current.gitStatusByWorktree,
        [primaryWorktree.id]: [],
        [commitWorktree.id]: [
          {
            path: 'e2e-commit-message-generation.txt',
            status: 'added' as const,
            area: 'staged' as const
          }
        ]
      },
      remoteStatusesByWorktree: {
        ...current.remoteStatusesByWorktree,
        [primaryWorktree.id]: {
          hasUpstream: true,
          upstreamName: primaryBranch,
          ahead: 0,
          behind: 0
        },
        [commitWorktree.id]: {
          hasUpstream: false,
          ahead: 0,
          behind: 0
        }
      },
      gitBranchCompareSummaryByWorktree: {
        ...current.gitBranchCompareSummaryByWorktree,
        [primaryWorktree.id]: {
          baseRef: primaryBranch,
          baseOid: null,
          compareRef: primaryBranch,
          headOid: null,
          mergeBase: null,
          changedFiles: 0,
          commitsAhead: 0,
          status: 'ready' as const
        }
      },
      gitBranchCompareEntriesByWorktree: {
        ...current.gitBranchCompareEntriesByWorktree,
        [primaryWorktree.id]: []
      }
    }))

    return {
      primaryWorktreeId: primaryWorktree.id,
      commitWorktreeId: commitWorktree.id,
      commitWorktreePath: commitWorktree.path
    }
  })
}

export async function seedCleanBranchEmptyState(
  page: Page,
  targetWorktreeId?: string
): Promise<string> {
  return page.evaluate(async (targetWorktreeId: string | null) => {
    const store =
      window.__store ??
      (() => {
        throw new Error('window.__store is not available')
      })()

    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const secondaryWorktree = worktrees.find(
      (entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary'
    )
    const primaryWorktree = worktrees.find((entry) =>
      targetWorktreeId
        ? entry.id === targetWorktreeId
        : secondaryWorktree
          ? entry.repoId === secondaryWorktree.repoId &&
            entry.id !== secondaryWorktree.id &&
            !entry.branch.replace(/^refs\/heads\//, '').startsWith('e2e-')
          : entry.branch.replace(/^refs\/heads\//, '').match(/^(main|master)$/)
    )
    if (!primaryWorktree) {
      throw new Error('Primary worktree not found')
    }

    const primaryBranch = primaryWorktree.branch.replace(/^refs\/heads\//, '')
    store.setState((current) => ({
      gitStatusByWorktree: { ...current.gitStatusByWorktree, [primaryWorktree.id]: [] },
      remoteStatusesByWorktree: {
        ...current.remoteStatusesByWorktree,
        [primaryWorktree.id]: {
          hasUpstream: true,
          upstreamName: primaryBranch,
          ahead: 0,
          behind: 0
        }
      },
      gitBranchCompareSummaryByWorktree: {
        ...current.gitBranchCompareSummaryByWorktree,
        [primaryWorktree.id]: {
          baseRef: primaryBranch,
          baseOid: null,
          compareRef: primaryBranch,
          headOid: null,
          mergeBase: null,
          changedFiles: 0,
          commitsAhead: 0,
          status: 'ready' as const
        }
      },
      gitBranchCompareEntriesByWorktree: {
        ...current.gitBranchCompareEntriesByWorktree,
        [primaryWorktree.id]: []
      }
    }))
    return primaryWorktree.id
  }, targetWorktreeId ?? null)
}

export function createBranchCommit(worktreePath: string): void {
  const changedFile = path.join(worktreePath, 'e2e-pr-generation-change.txt')
  writeFileSync(changedFile, `PR generation worktree switch validation ${Date.now()}\n`)
  execFileSync('git', ['add', 'e2e-pr-generation-change.txt'], { cwd: worktreePath })
  execFileSync('git', ['commit', '-m', 'E2E PR generation change'], { cwd: worktreePath })
}

export function createStagedCommitMessageChange(worktreePath: string): void {
  const changedFile = path.join(worktreePath, 'e2e-commit-message-generation.txt')
  writeFileSync(changedFile, `Commit message worktree switch validation ${Date.now()}\n`)
  execFileSync('git', ['add', 'e2e-commit-message-generation.txt'], { cwd: worktreePath })
}
