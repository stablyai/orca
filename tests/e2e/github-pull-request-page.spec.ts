/**
 * E2E coverage for the GitHub Pull Request detail page rendered inside the Tasks view
 * (`src/renderer/src/components/pull-request-page`, mounted by `task-page/Content.tsx`).
 *
 * Flows covered:
 *  1. Opening a PR from the tasks surface renders the PR header, the Conversation /
 *     Files changed / Checks tabs, and the PR description body.
 *  2. "Files changed" lists the changed files; toggling a file's Viewed checkbox calls
 *     the provider mutation and flips the toolbar's viewed count.
 *  3. The conversation renders existing comments; posting a comment hits the provider
 *     mutation and paints the returned comment.
 *  4. The merge control and state actions render for a mergeable open PR.
 *  5. The Checks tab lists the PR's check runs.
 *
 * The page reads details through `window.api.gh.workItemDetails`, so the provider is
 * stubbed at the main-process IPC boundary (contextIsolation keeps `window.api` read-only).
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../src/shared/github/work-item-types'

type PrWorkItemSeed = Omit<GitHubWorkItem, 'repoId'>

type PrBackendProbe = {
  commentBodies: string[]
  viewedToggles: { path: string; viewed: boolean }[]
}

const PR = {
  number: 4242,
  title: 'Add deterministic PR page coverage',
  url: 'https://github.com/orca-e2e/orca/pull/4242',
  author: 'octocat',
  body: 'This pull request adds end-to-end coverage for the PR detail page.',
  updatedAt: '2026-08-08T00:00:00.000Z',
  branchName: 'feat/pr-page-e2e',
  baseRefName: 'main',
  headSha: 'head-sha-4242',
  baseSha: 'base-sha-0000',
  pullRequestId: 'PR_kwDOe2eE2E',
  firstFilePath: 'src/math.ts'
} as const

function prWorkItemSeed(state: GitHubWorkItem['state']): PrWorkItemSeed {
  return {
    id: `pr-${PR.number}`,
    type: 'pr',
    number: PR.number,
    title: PR.title,
    state,
    url: PR.url,
    labels: [],
    updatedAt: PR.updatedAt,
    author: PR.author,
    branchName: PR.branchName,
    baseRefName: PR.baseRefName,
    headSha: PR.headSha,
    mergeable: 'MERGEABLE',
    mergeMethodSettings: {
      defaultMethod: 'squash',
      allowedMethods: { squash: true, merge: true, rebase: true }
    },
    reviewRequests: [],
    assignees: []
  }
}

function makeDetails(): GitHubWorkItemDetails {
  return {
    item: prWorkItemSeed('open'),
    body: PR.body,
    comments: [
      {
        id: 1001,
        author: 'reviewer-bot',
        authorAvatarUrl: '',
        body: 'Existing conversation comment.',
        createdAt: PR.updatedAt,
        url: `${PR.url}#issuecomment-1001`
      }
    ],
    headSha: PR.headSha,
    baseSha: PR.baseSha,
    pullRequestId: PR.pullRequestId,
    files: [
      {
        path: PR.firstFilePath,
        status: 'modified',
        additions: 3,
        deletions: 1,
        isBinary: false,
        viewerViewedState: 'UNVIEWED'
      },
      {
        path: 'src/strings.ts',
        status: 'added',
        additions: 5,
        deletions: 0,
        isBinary: false,
        viewerViewedState: 'UNVIEWED'
      }
    ],
    checks: [
      {
        name: 'E2E build',
        status: 'completed',
        conclusion: 'success',
        url: `${PR.url}/checks/1`,
        checkRunId: 1
      }
    ]
  }
}

/**
 * Stub the GitHub provider IPC the PR page reads/writes through. `contextIsolation`
 * makes `window.api` non-writable in the renderer, so the stubs live in main.
 */
async function installPullRequestBackend(
  electronApp: ElectronApplication,
  details: GitHubWorkItemDetails
): Promise<void> {
  await electronApp.evaluate(
    ({ ipcMain }, fixture) => {
      const recorded: PrBackendProbe = { commentBodies: [], viewedToggles: [] }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spec-private main-process probe global; only this spec's stubbed handlers write and read it.
      ;(globalThis as typeof globalThis & { __orcaPrE2E?: PrBackendProbe }).__orcaPrE2E = recorded

      ipcMain.removeHandler('gh:workItemDetails')
      ipcMain.handle('gh:workItemDetails', async () => fixture.details)

      ipcMain.removeHandler('gh:prFileContents')
      ipcMain.handle('gh:prFileContents', async () => ({
        original: 'const value = 1\n',
        modified: 'const value = 2\n',
        originalIsBinary: false,
        modifiedIsBinary: false
      }))

      ipcMain.removeHandler('gh:addIssueComment')
      ipcMain.handle('gh:addIssueComment', async (_event, args: { body: string }) => {
        recorded.commentBodies.push(args.body)
        return {
          ok: true,
          comment: {
            id: 9001,
            author: fixture.author,
            authorAvatarUrl: '',
            body: args.body,
            createdAt: '2026-08-08T00:00:00.000Z',
            url: `${fixture.details.item.url}#issuecomment-9001`
          }
        }
      })

      ipcMain.removeHandler('gh:setPRFileViewed')
      ipcMain.handle(
        'gh:setPRFileViewed',
        async (_event, args: { path: string; viewed: boolean }) => {
          recorded.viewedToggles.push({ path: args.path, viewed: args.viewed })
          return true
        }
      )

      ipcMain.removeHandler('gh:mergePR')
      ipcMain.handle('gh:mergePR', async () => ({ ok: true }))
    },
    { details, author: details.item.author ?? 'octocat' }
  )
}

async function readBackendProbe(electronApp: ElectronApplication): Promise<PrBackendProbe> {
  return electronApp.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the spec-private main-process probe global its stubbed handlers wrote.
    const probe = (globalThis as typeof globalThis & { __orcaPrE2E?: PrBackendProbe }).__orcaPrE2E
    return probe ?? { commentBodies: [], viewedToggles: [] }
  })
}

/** Open the Tasks view with a GitHub PR selected, using the seeded repo as its owner. */
async function openPullRequestPage(
  page: Page,
  options: {
    state?: GitHubWorkItem['state']
    initialTab?: 'conversation' | 'files' | 'checks'
  } = {}
): Promise<void> {
  await page.evaluate(
    (args) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const appState = store.getState()
      const activeWorktree = Object.values(appState.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === appState.activeWorktreeId)
      const repo =
        appState.repos.find((candidate) => candidate.id === activeWorktree?.repoId) ??
        appState.repos[0]
      if (!repo) {
        throw new Error('No repository available for the PR page')
      }
      // Why: the list is not rendered behind the detail, so skip its prefetch round-trip.
      store.setState({ prefetchWorkItems: () => undefined })
      store.getState().openTaskPage(
        {
          taskSource: 'github',
          preselectedRepoId: repo.id,
          openGitHubWorkItem: { ...args.item, repoId: repo.id },
          openGitHubInitialTab: args.initialTab
        },
        { recordTasksInteraction: false }
      )
    },
    {
      item: prWorkItemSeed(options.state ?? 'open'),
      initialTab: options.initialTab ?? 'conversation'
    }
  )
}

test.describe('GitHub pull request detail page', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('renders the PR header, tabs, and description', async ({ orcaPage, electronApp }) => {
    await installPullRequestBackend(electronApp, makeDetails())
    await openPullRequestPage(orcaPage)

    await expect(
      orcaPage.getByRole('heading', { name: /Add deterministic PR page coverage/ })
    ).toBeVisible({ timeout: 15_000 })
    await expect(orcaPage.getByRole('button', { name: 'Pull requests' })).toBeVisible()
    // Why: the PR number renders twice (header strip + title heading); assert on the heading.
    await expect(orcaPage.getByRole('heading', { name: new RegExp(`#${PR.number}`) })).toBeVisible()

    await expect(orcaPage.getByRole('tab', { name: /Conversation/ })).toBeVisible()
    await expect(orcaPage.getByRole('tab', { name: /Files changed/ })).toBeVisible()
    await expect(orcaPage.getByRole('tab', { name: /Checks/ })).toBeVisible()

    await expect(orcaPage.getByText(PR.body)).toBeVisible()
  })

  test('Files changed lists files and the Viewed toggle updates the count', async ({
    orcaPage,
    electronApp
  }) => {
    await installPullRequestBackend(electronApp, makeDetails())
    await openPullRequestPage(orcaPage)

    await orcaPage.getByRole('tab', { name: /Files changed/ }).click()

    const markViewed = orcaPage.getByRole('checkbox', {
      name: `Mark ${PR.firstFilePath} as viewed`
    })
    await expect(markViewed).toBeVisible({ timeout: 15_000 })
    await expect(orcaPage.getByText('0 / 2 files viewed')).toBeVisible()

    await markViewed.click()

    await expect(
      orcaPage.getByRole('checkbox', { name: `Unmark ${PR.firstFilePath} as viewed` })
    ).toHaveAttribute('aria-checked', 'true')
    await expect(orcaPage.getByText('1 / 2 files viewed')).toBeVisible()

    const probe = await readBackendProbe(electronApp)
    expect(probe.viewedToggles).toEqual([{ path: PR.firstFilePath, viewed: true }])
  })

  test('shows existing comments and posts a new comment through the provider', async ({
    orcaPage,
    electronApp
  }) => {
    await installPullRequestBackend(electronApp, makeDetails())
    await openPullRequestPage(orcaPage)

    await expect(orcaPage.getByText('Existing conversation comment.')).toBeVisible({
      timeout: 15_000
    })

    const composer = orcaPage.getByPlaceholder('Add a comment…')
    await composer.fill('Posted from the e2e spec')
    await orcaPage.getByRole('button', { name: 'Send comment' }).click()

    await expect(orcaPage.getByText('Posted from the e2e spec')).toBeVisible({ timeout: 15_000 })

    const probe = await readBackendProbe(electronApp)
    expect(probe.commentBodies).toEqual(['Posted from the e2e spec'])
  })

  test('renders the merge control and state actions for an open PR', async ({
    orcaPage,
    electronApp
  }) => {
    await installPullRequestBackend(electronApp, makeDetails())
    await openPullRequestPage(orcaPage, { state: 'open' })

    await expect(orcaPage.getByText('Pull request', { exact: true })).toBeVisible({
      timeout: 15_000
    })
    // Why: a mergeable open PR with no review gate offers the repo's default merge method.
    await expect(orcaPage.getByRole('button', { name: 'Squash and merge' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Close pull request' })).toBeVisible()
  })

  test('Checks tab lists the PR check runs', async ({ orcaPage, electronApp }) => {
    await installPullRequestBackend(electronApp, makeDetails())
    await openPullRequestPage(orcaPage)

    const checksTab = orcaPage.getByRole('tab', { name: /Checks/ })
    await expect(checksTab).toBeVisible({ timeout: 15_000 })
    await checksTab.click()
    await expect(checksTab).toHaveAttribute('aria-selected', 'true')

    const checksPanel = orcaPage.getByRole('tabpanel').filter({ hasText: 'E2E build' })
    await expect(checksPanel).toBeVisible()
    await expect(checksPanel.getByText('All checks passing')).toBeVisible()
  })
})
