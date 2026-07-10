import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { CreateHostedReviewResult } from '../../src/shared/hosted-review'

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

async function openSourceControl(page: Page, expectedWorktreeId: string): Promise<void> {
  await page.evaluate((expectedWorktreeId) => {
    const state = window.__store?.getState()
    if (state && state.activeWorktreeId !== expectedWorktreeId) {
      state.setActiveWorktree(expectedWorktreeId)
    }
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('source-control')
  }, expectedWorktreeId)
  await expect
    .poll(
      async () =>
        page.evaluate((expectedWorktreeId) => {
          const state = window.__store?.getState()
          if (!state) {
            return false
          }
          const activeWorktree = Object.values(state.worktreesByRepo)
            .flat()
            .some((entry) => entry.id === expectedWorktreeId)
          return (
            activeWorktree &&
            state.activeWorktreeId === expectedWorktreeId &&
            state.rightSidebarOpen &&
            state.rightSidebarTab === 'source-control'
          )
        }, expectedWorktreeId),
      { timeout: 5_000 }
    )
    .toBe(true)
  await expect(page.getByRole('button', { name: /Source Control/ })).toBeVisible()
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

function getCreatePRComposer(page: Page): Locator {
  const titleInput = page.getByRole('textbox', { name: 'Pull request title' })
  const descriptionLabelPredicate =
    'translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")=' +
    '"pull request description"'
  return titleInput.locator(
    `
    xpath=ancestor::*[.//textarea[${descriptionLabelPredicate}]
      and .//button[normalize-space(.)="Create PR"]][1]
  `.trim()
  )
}

function getCreatePRComposerSubmitButton(page: Page): Locator {
  // Why: the header and composer currently share the same accessible name.
  // Anchor to the field container so this submits the editable composer.
  return getCreatePRComposer(page).getByRole('button', { name: 'Create PR' })
}

async function seedCreatePREligibleBranch(
  page: Page,
  options: { createResult?: CreateHostedReviewResult } = {}
): Promise<{ branch: string; worktreeId: string }> {
  return page.evaluate(async ({ createResult }) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const worktree = worktrees.find(
      (entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary'
    )
    if (!worktree) {
      throw new Error('seeded e2e-secondary worktree not found')
    }
    // Why: the worker-scoped test repo can accumulate extra non-main
    // worktrees; use the seeded secondary worktree as the stable PR target.
    state.setActiveWorktree(worktree.id)
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
      head: branch
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
        if (createResult) {
          return createResult
        }
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
  }, options)
}

test.describe('Source Control create pull request', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('creates the pull request from the Source Control primary action', async ({ orcaPage }) => {
    const { branch, worktreeId } = await seedCreatePREligibleBranch(orcaPage)
    await openSourceControl(orcaPage, worktreeId)
    await forceCreatePREligibleStatus(orcaPage, worktreeId, branch)

    const titleInput = orcaPage.getByRole('textbox', { name: 'Pull request title' })
    const descriptionInput = orcaPage.getByRole('textbox', {
      name: 'Pull request description'
    })
    const createButton = getCreatePRComposerSubmitButton(orcaPage)
    await expect(createButton).toBeVisible({ timeout: 10_000 })
    await expect(createButton).toBeEnabled()
    await expect(titleInput).toHaveValue('E2e secondary')
    await expect(orcaPage.getByRole('textbox', { name: 'Pull request base branch' })).toHaveValue(
      'main'
    )
    await expect(descriptionInput).toHaveValue('')
    await descriptionInput.fill('- Initial commit for E2E')
    await expect(createButton).toBeEnabled()
    await createButton.click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            () =>
              (window as unknown as { __createPRPayloads: CreatePRPayload[] }).__createPRPayloads
                .length
          ),
        { timeout: 10_000 }
      )
      .toBe(1)

    const payloads = await orcaPage.evaluate(
      () => (window as unknown as { __createPRPayloads: CreatePRPayload[] }).__createPRPayloads
    )
    expect(payloads).toHaveLength(1)
    expect(payloads[0].input).toMatchObject({
      provider: 'github',
      base: 'main',
      head: branch,
      title: 'E2e secondary',
      body: '- Initial commit for E2E',
      draft: false
    })
  })

  test('surfaces create failures without clearing the pull request composer', async ({
    orcaPage
  }) => {
    const failureMessage = 'Create PR failed: GitHub API rate limit exceeded'
    const { branch, worktreeId } = await seedCreatePREligibleBranch(orcaPage, {
      createResult: {
        ok: false,
        code: 'unknown',
        error: failureMessage
      }
    })
    await openSourceControl(orcaPage, worktreeId)
    await forceCreatePREligibleStatus(orcaPage, worktreeId, branch)

    const titleInput = orcaPage.getByRole('textbox', { name: 'Pull request title' })
    const descriptionInput = orcaPage.getByRole('textbox', {
      name: 'Pull request description'
    })
    const createButton = getCreatePRComposerSubmitButton(orcaPage)
    await expect(createButton).toBeVisible({ timeout: 10_000 })
    await titleInput.fill('Failing PR from E2E')
    await descriptionInput.fill('This draft should survive a failed create attempt.')
    await expect(createButton).toBeEnabled()
    await createButton.click()

    await expect(orcaPage.getByText(failureMessage)).toBeVisible()
    await expect(titleInput).toHaveValue('Failing PR from E2E')
    await expect(descriptionInput).toHaveValue('This draft should survive a failed create attempt.')
    await expect(orcaPage.getByRole('textbox', { name: 'Pull request base branch' })).toHaveValue(
      'main'
    )
    await expect(createButton).toBeEnabled()
  })
})
