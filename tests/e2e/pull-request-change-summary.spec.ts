import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const PR_TITLE = 'Improve pull request review header'

const PR_DETAILS = {
  item: {
    id: 'pr:13773',
    type: 'pr',
    number: 13773,
    title: PR_TITLE,
    state: 'open',
    url: 'https://github.com/stablyai/orca/pull/13773',
    labels: ['enhancement'],
    updatedAt: '2026-08-11T00:00:00Z',
    author: 'orca-contributor',
    branchName: 'feat/pr-change-summary',
    baseRefName: 'main',
    additions: 128,
    deletions: 34,
    changedFiles: 5
  },
  body: '',
  comments: [],
  checks: [],
  files: []
} as const

async function installGitHubDetailsBackend(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, details) => {
    ipcMain.removeHandler('gh:workItemDetails')
    ipcMain.handle('gh:workItemDetails', async () => details)
  }, PR_DETAILS)
}

async function openMockedPullRequest(page: Page): Promise<void> {
  await page.evaluate((title) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const activeWorktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === state.activeWorktreeId)
    const repo = state.repos.find((candidate) => candidate.id === activeWorktree?.repoId)
    if (!repo || !state.settings) {
      throw new Error('Pull request summary fixture requires a ready repository')
    }

    const pullRequest = {
      id: 'pr:13773',
      type: 'pr' as const,
      number: 13773,
      title,
      state: 'open' as const,
      url: 'https://github.com/stablyai/orca/pull/13773',
      labels: ['enhancement'],
      updatedAt: '2026-08-11T00:00:00Z',
      author: 'orca-contributor',
      branchName: 'feat/pr-change-summary',
      baseRefName: 'main',
      repoId: repo.id
    }

    store.setState({
      repos: state.repos.map((candidate) =>
        candidate.id === repo.id
          ? { ...candidate, upstream: { owner: 'stablyai', repo: 'orca' } }
          : candidate
      ),
      settings: {
        ...state.settings,
        theme: 'light',
        defaultTaskSource: 'github',
        defaultTaskViewPreset: 'prs',
        visibleTaskProviders: ['github']
      },
      taskResumeState: {
        ...state.taskResumeState,
        githubItemsPreset: 'prs',
        githubItemsQuery: 'is:pr is:open',
        githubMode: 'items'
      },
      prefetchWorkItems: () => undefined,
      fetchWorkItemsAcrossRepos: async () => ({
        items: [pullRequest],
        failedCount: 0,
        githubUnavailable: false
      }),
      countWorkItemsAcrossRepos: async () => ({ totalCount: 1, totalPages: 1 })
    })
    store
      .getState()
      .openTaskPage(
        { taskSource: 'github', preselectedRepoId: repo.id },
        { recordTasksInteraction: false }
      )
  }, PR_TITLE)

  await expect(page.getByText(PR_TITLE, { exact: true })).toBeVisible()
  await page.getByText(PR_TITLE, { exact: true }).click()
}

test('shows PR line totals in the detail header and captures both themes', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await installGitHubDetailsBackend(electronApp)
  await openMockedPullRequest(orcaPage)

  const heading = orcaPage.getByRole('heading', {
    name: new RegExp(`${PR_TITLE}\\s*#13773`)
  })
  const summary = orcaPage.locator('[data-pull-request-change-summary]')
  await expect(heading).toBeVisible()
  await expect(summary).toHaveAccessibleName('128 lines added, 34 lines deleted')
  await expect(summary).toContainText('+128')
  await expect(summary).toContainText('-34')

  const titleBlock = heading.locator('..').locator('..')
  await expect(orcaPage.locator('html')).not.toHaveClass(/dark/)
  await titleBlock.screenshot({
    path: testInfo.outputPath('pull-request-change-summary-light.png')
  })

  await orcaPage.evaluate(() => {
    const store = window.__store
    const settings = store?.getState().settings
    if (!store || !settings) {
      throw new Error('Settings unavailable while switching visual QA theme')
    }
    store.setState({ settings: { ...settings, theme: 'dark' } })
  })
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await titleBlock.screenshot({
    path: testInfo.outputPath('pull-request-change-summary-dark.png')
  })
})
