import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type CreatePRPayload = {
  repoPath: string
  input: {
    provider: string
    base: string
    head?: string
    title: string
    body?: string
    draft?: boolean
  }
}

async function openSourceControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('source-control')
  })
  await expect(page.getByRole('button', { name: /Source Control/ })).toBeVisible()
  await expect(page.getByLabel('Commit message')).toBeVisible()
}

async function forceCreatePREligibleStatus(
  page: Page,
  worktreeId: string,
  branch: string
): Promise<void> {
  await page.evaluate(
    ({ worktreeId, branch }) => {
      window.__store?.setState((current) => ({
        remoteStatusesByWorktree: {
          ...current.remoteStatusesByWorktree,
          [worktreeId]: {
            hasUpstream: true,
            upstreamName: `origin/${branch}`,
            ahead: 0,
            behind: 0
          }
        }
      }))
    },
    { worktreeId, branch }
  )
}

async function seedCreatePREligibleBranch(
  page: Page
): Promise<{ branch: string; worktreeId: string }> {
  return page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const activeWorktree = worktrees.find((entry) => entry.id === worktreeId)
    const worktree =
      worktrees.find((entry) => {
        const branchName = entry.branch.replace(/^refs\/heads\//, '')
        return branchName !== 'main' && !entry.isMainWorktree
      }) ?? activeWorktree
    if (!worktree) {
      throw new Error('active worktree not found')
    }
    if (state.activeWorktreeId !== worktree.id) {
      state.setActiveWorktree(worktree.id)
    }
    const repo = state.repos.find((entry) => entry.id === worktree.repoId)
    if (!repo) {
      throw new Error('active repo not found')
    }
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const pr = {
      number: 73,
      title: 'Create PR from E2E',
      state: 'open' as const,
      url: 'https://github.com/acme/orca/pull/73',
      checksStatus: 'pending' as const,
      updatedAt: '2026-05-15T00:00:00.000Z',
      mergeable: 'UNKNOWN' as const
    }
    const eligibility = {
      provider: 'github' as const,
      review: null,
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      defaultBaseRef: 'origin/main',
      head: branch,
      title: 'Create PR from E2E',
      body: '- Initial commit for E2E'
    }

    ;(window as unknown as { __createPRPayloads: CreatePRPayload[] }).__createPRPayloads = []
    store.setState((current) => ({
      repos: current.repos.map((candidate) =>
        candidate.id === repo.id ? { ...candidate, worktreeBaseRef: 'origin/main' } : candidate
      ),
      gitStatusByWorktree: {
        ...current.gitStatusByWorktree,
        [worktree.id]: []
      },
      remoteStatusesByWorktree: {
        ...current.remoteStatusesByWorktree,
        [worktree.id]: {
          hasUpstream: true,
          upstreamName: `origin/${branch}`,
          ahead: 0,
          behind: 0
        }
      },
      getHostedReviewCreationEligibility: async () => eligibility,
      fetchHostedReviewForBranch: async () => null,
      setUpstreamStatus: () => undefined,
      fetchUpstreamStatus: async () => undefined,
      fetchPRForBranch: async (repoPath: string, targetBranch: string) => {
        store.setState((next) => ({
          prCache: {
            ...next.prCache,
            [`${repo.id}::${targetBranch}`]: {
              data: pr,
              fetchedAt: Date.now()
            },
            [`${repoPath}::${targetBranch}`]: {
              data: pr,
              fetchedAt: Date.now()
            }
          }
        }))
        return pr
      },
      fetchPRChecks: async () => [],
      fetchPRComments: async () => [],
      createHostedReview: async (repoPath, input) => {
        ;(window as unknown as { __createPRPayloads: CreatePRPayload[] }).__createPRPayloads.push({
          repoPath,
          input
        })
        return {
          ok: true as const,
          number: 73,
          url: 'https://github.com/acme/orca/pull/73'
        }
      }
    }))

    state.setRightSidebarOpen(true)
    state.setRightSidebarTab('source-control')
    return { branch, worktreeId: worktree.id }
  })
}

test.describe('Source Control create pull request', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('opens the PR dialog from Source Control and creates the pull request', async ({
    orcaPage
  }) => {
    const { branch, worktreeId } = await seedCreatePREligibleBranch(orcaPage)
    await openSourceControl(orcaPage)
    await forceCreatePREligibleStatus(orcaPage, worktreeId, branch)

    const createButton = orcaPage.getByRole('button', { name: 'Create PR' })
    await expect(createButton).toBeVisible({ timeout: 10_000 })
    await expect(createButton).toBeEnabled()
    await createButton.click()

    const dialog = orcaPage.getByRole('dialog', { name: 'Create Pull Request' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(branch)
    await expect(dialog.getByLabel('Base branch')).toHaveValue('main')
    await expect(dialog.getByLabel('Title')).toHaveValue('Create PR from E2E')
    await expect(dialog.getByLabel('Description')).toHaveValue('- Initial commit for E2E')

    await dialog.getByRole('button', { name: 'Create PR' }).click()

    await expect(dialog).toBeHidden({ timeout: 10_000 })
    await expect(orcaPage.getByText('Create PR from E2E')).toBeVisible({ timeout: 10_000 })

    const payloads = await orcaPage.evaluate(
      () => (window as unknown as { __createPRPayloads: CreatePRPayload[] }).__createPRPayloads
    )
    expect(payloads).toHaveLength(1)
    expect(payloads[0].input).toMatchObject({
      provider: 'github',
      base: 'main',
      head: branch,
      title: 'Create PR from E2E',
      body: '- Initial commit for E2E',
      draft: false
    })
  })
})
