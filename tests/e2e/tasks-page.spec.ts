import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, getStoreState } from './helpers/store'
import { GITHUB_TASK_SEARCH_IDLE_MS } from '../../src/renderer/src/components/use-github-task-search-commit'

// Derive cadence from idle timing so slow keystrokes cannot commit a prefix.
const TASK_SEARCH_TYPING_DELAY_MS = Math.round(GITHUB_TASK_SEARCH_IDLE_MS / 6)
const TASK_SEARCH_SETTLE_MS = GITHUB_TASK_SEARCH_IDLE_MS + 50
// Outlast idle timing, React commit and two store roundtrips instead of assuming a flat 2s.
const TASK_SEARCH_PROBE_TIMEOUT_MS = GITHUB_TASK_SEARCH_IDLE_MS * 6

type TaskSearchRequestProbe = {
  countQueries: string[]
  fetchQueries: string[]
}

async function openTasksPage(page: Parameters<typeof getStoreState>[0]): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().openTaskPage()
  })
}

async function openMockedPaginatedGitHubTasks(
  page: Parameters<typeof getStoreState>[0],
  app: ElectronApplication
): Promise<void> {
  // Fake GitHub per repo at IPC so production list acceptance and count publication drive the pager.
  await app.evaluate(({ ipcMain }) => {
    // 1000 results at the single-repo page width of 36 is 28 pages; the last page holds 28 rows.
    const totalCount = 1000
    // The fixture repo is a non-fork: origin is its only candidate and the effective source.
    const target = { owner: 'example', repo: 'repo' }
    ipcMain.removeHandler('gh:listWorkItems')
    ipcMain.handle('gh:listWorkItems', (_event, args: { limit?: number; page?: number }) => {
      const limit = args.limit ?? 36
      const pageNumber = args.page ?? 1
      const length = Math.max(0, Math.min(limit, totalCount - (pageNumber - 1) * limit))
      return {
        items: Array.from({ length }, (_, index) => ({
          id: `issue-${pageNumber}-${index + 1}`,
          type: 'issue' as const,
          number: pageNumber * 100 + index + 1,
          title: `Issue page ${pageNumber} item ${index + 1}`,
          state: 'open' as const,
          url: `https://github.com/example/repo/issues/${pageNumber * 100 + index + 1}`,
          labels: [],
          updatedAt: new Date(1_700_000_000_000 - index * 1_000).toISOString(),
          author: 'octocat'
        })),
        sources: { issues: target, prs: target, originCandidate: target, upstreamCandidate: null }
      }
    })
    ipcMain.removeHandler('gh:countWorkItems')
    ipcMain.handle('gh:countWorkItems', () => totalCount)
  })
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const repos = store.getState().repos.map((repo, index) =>
      index === 0
        ? {
            ...repo,
            gitRemoteIdentity: {
              canonicalKey: 'github.com/example/repo',
              remoteName: 'origin',
              remoteUrl: 'https://github.com/example/repo.git'
            }
          }
        : repo
    )
    store.setState({ repos })
    store.getState().openTaskPage({ taskSource: 'github' })
  })
}

async function openInstrumentedGitHubTasksPage(
  page: Parameters<typeof getStoreState>[0]
): Promise<void> {
  await page.evaluate(() => {
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
      throw new Error('GitHub Tasks probe requires a ready repository and settings')
    }
    const probe: TaskSearchRequestProbe = { countQueries: [], fetchQueries: [] }
    ;(
      window as typeof window & { __taskSearchRequestProbe?: TaskSearchRequestProbe }
    ).__taskSearchRequestProbe = probe
    const existingIssue = {
      id: 'issue:999',
      type: 'issue' as const,
      number: 999,
      title: 'Existing GitHub issue',
      state: 'open' as const,
      url: 'https://github.com/orca/e2e/issues/999',
      labels: [],
      updatedAt: '2026-08-08T00:00:00Z',
      author: 'orca-e2e',
      repoId: repo.id,
      assignees: [],
      reviewRequests: []
    }

    store.setState({
      repos: state.repos.map((candidate) =>
        candidate.id === repo.id
          ? { ...candidate, upstream: { owner: 'orca', repo: 'e2e' } }
          : candidate
      ),
      settings: {
        ...state.settings,
        defaultTaskSource: 'github',
        defaultTaskViewPreset: 'issues',
        visibleTaskProviders: ['github']
      },
      taskResumeState: {
        ...state.taskResumeState,
        githubItemsPreset: 'issues',
        githubItemsQuery: 'is:issue is:open',
        githubMode: 'items'
      },
      prefetchWorkItems: () => undefined,
      fetchWorkItemsAcrossRepos: async (_repos, _perRepoLimit, _displayLimit, query) => {
        probe.fetchQueries.push(query)
        return { items: [existingIssue], failedCount: 0, githubUnavailable: false }
      },
      countWorkItemsAcrossRepos: async (_repos, query) => {
        probe.countQueries.push(query)
        return { totalCount: 1, totalPages: 1 }
      }
    })
    store
      .getState()
      .openTaskPage(
        { taskSource: 'github', preselectedRepoId: repo.id },
        { recordTasksInteraction: false }
      )
  })
}

async function readTaskSearchRequestProbe(
  page: Parameters<typeof getStoreState>[0]
): Promise<TaskSearchRequestProbe> {
  return page.evaluate(() => {
    const probe = (window as typeof window & { __taskSearchRequestProbe?: TaskSearchRequestProbe })
      .__taskSearchRequestProbe
    if (!probe) {
      throw new Error('Task search request probe is not installed')
    }
    return { countQueries: [...probe.countQueries], fetchQueries: [...probe.fetchQueries] }
  })
}

async function resetTaskSearchRequestProbe(
  page: Parameters<typeof getStoreState>[0]
): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as typeof window & { __taskSearchRequestProbe?: TaskSearchRequestProbe })
      .__taskSearchRequestProbe
    if (!probe) {
      throw new Error('Task search request probe is not installed')
    }
    probe.countQueries.length = 0
    probe.fetchQueries.length = 0
  })
}

test.describe('Tasks page', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('reopening restores the GitHub page and scroll position', async ({
    orcaPage,
    electronApp
  }) => {
    await openMockedPaginatedGitHubTasks(orcaPage, electronApp)

    await orcaPage.getByRole('button', { name: 'Page 28', exact: true }).click()
    await expect(orcaPage.getByText('Issue page 28 item 1', { exact: true })).toBeVisible()

    const list = orcaPage.locator('[data-task-list-scroll="github"]')
    await list.evaluate((element) => {
      element.scrollTop = 360
      element.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(300)

    await orcaPage.getByRole('button', { name: 'Close tasks' }).click()
    await expect(list).toHaveCount(0)
    const clampedRowsStyle = await orcaPage.addStyleTag({
      content:
        '[data-task-list-scroll="github"] > .divide-y { max-height: 0 !important; overflow: hidden !important; }'
    })
    await openTasksPage(orcaPage)

    await expect(orcaPage.getByRole('button', { name: 'Page 28', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )
    const restoredList = orcaPage.locator('[data-task-list-scroll="github"]')
    await expect.poll(() => restoredList.evaluate((element) => element.scrollTop)).toBe(0)
    await clampedRowsStyle.evaluate((element) => {
      element.parentNode?.removeChild(element)
    })
    await expect(orcaPage.getByText('Issue page 28 item 1', { exact: true })).toBeVisible()
    await expect
      .poll(() => restoredList.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(300)

    await orcaPage.getByText('Issue page 28 item 12', { exact: true }).click()
    await expect(restoredList).toHaveCount(0)
    await expect
      .poll(async () => {
        const position = await getStoreState<{ scrollTop: number }>(orcaPage, 'taskListPosition')
        return position.scrollTop
      })
      .toBeGreaterThan(300)
    await orcaPage.getByRole('button', { name: 'GitHub list', exact: true }).click()
    await expect(orcaPage.getByText('Issue page 28 item 1', { exact: true })).toBeVisible()
    await expect
      .poll(() => restoredList.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(300)

    await orcaPage.getByRole('button', { name: 'Close tasks' }).click()
    const pendingRestoreStyle = await orcaPage.addStyleTag({
      content:
        '[data-task-list-scroll="github"] > .divide-y { max-height: 0 !important; overflow: hidden !important; }'
    })
    await openTasksPage(orcaPage)
    await expect(orcaPage.getByRole('button', { name: 'Page 28', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await orcaPage.getByRole('button', { name: 'Page 1', exact: true }).click()
    await pendingRestoreStyle.evaluate((element) => {
      element.parentNode?.removeChild(element)
    })
    await expect(orcaPage.getByRole('button', { name: 'Page 1', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await expect
      .poll(() =>
        orcaPage
          .locator('[data-task-list-scroll="github"]')
          .evaluate((element) => element.scrollTop)
      )
      .toBe(0)

    await orcaPage.getByRole('button', { name: 'Page 28', exact: true }).click()
    await expect(orcaPage.getByText('Issue page 28 item 1', { exact: true })).toBeVisible()
    await restoredList.evaluate((element) => {
      element.scrollTop = 360
      element.dispatchEvent(new Event('scroll'))
    })
    await expect
      .poll(() => restoredList.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(300)
    await orcaPage.getByRole('button', { name: 'Close tasks' }).click()

    const permanentlyClampedRowsStyle = await orcaPage.addStyleTag({
      content:
        '[data-task-list-scroll="github"] > .divide-y { max-height: 0 !important; overflow: hidden !important; }'
    })
    await openTasksPage(orcaPage)
    await expect(orcaPage.getByRole('button', { name: 'Page 28', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )
    // Outlast the old 5s restore give-up so an unpainted list cannot overwrite remembered scroll with zero.
    await orcaPage.waitForTimeout(5_500)
    await orcaPage.getByRole('button', { name: 'Close tasks' }).click()
    await expect
      .poll(async () => {
        const position = await getStoreState<{ scrollTop: number }>(orcaPage, 'taskListPosition')
        return position.scrollTop
      })
      .toBeGreaterThan(300)
    await permanentlyClampedRowsStyle.evaluate((element) => {
      element.parentNode?.removeChild(element)
    })
  })

  test('GitHub search waits for idle, keeps rows visible, and Enter does not double-fetch', async ({
    orcaPage
  }) => {
    await openInstrumentedGitHubTasksPage(orcaPage)

    const input = orcaPage.getByPlaceholder('Search GitHub issues...')
    const existingIssue = orcaPage.getByText('Existing GitHub issue', { exact: true })
    await expect(input).toBeVisible()
    await expect(existingIssue).toBeVisible()

    await input.fill('')
    await expect
      .poll(async () => readTaskSearchRequestProbe(orcaPage), {
        timeout: TASK_SEARCH_PROBE_TIMEOUT_MS
      })
      .toEqual({ countQueries: ['is:issue is:open'], fetchQueries: ['is:issue is:open'] })
    await resetTaskSearchRequestProbe(orcaPage)

    await input.pressSequentially('rate', { delay: TASK_SEARCH_TYPING_DELAY_MS })

    await expect(existingIssue).toBeVisible()

    // Require one final-value request per surface, never a typed prefix.
    await expect
      .poll(async () => readTaskSearchRequestProbe(orcaPage), {
        timeout: TASK_SEARCH_PROBE_TIMEOUT_MS
      })
      .toEqual({ countQueries: ['is:issue rate'], fetchQueries: ['is:issue rate'] })

    await resetTaskSearchRequestProbe(orcaPage)
    await input.pressSequentially('x')
    await input.press('Enter')

    await expect
      .poll(async () => readTaskSearchRequestProbe(orcaPage), {
        timeout: TASK_SEARCH_PROBE_TIMEOUT_MS
      })
      .toEqual({ countQueries: ['is:issue ratex'], fetchQueries: ['is:issue ratex'] })
    await orcaPage.waitForTimeout(TASK_SEARCH_SETTLE_MS)
    expect(await readTaskSearchRequestProbe(orcaPage)).toEqual({
      countQueries: ['is:issue ratex'],
      fetchQueries: ['is:issue ratex']
    })
    await expect(input).toHaveValue('is:issue ratex')
    await expect(existingIssue).toBeVisible()
  })
})
