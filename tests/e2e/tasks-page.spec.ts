/**
 * E2E tests for the Tasks page.
 *
 * Verifies that opening the tasks view renders correctly and that the
 * source controls and close affordance are present.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, getStoreState } from './helpers/store'
import { GITHUB_TASK_SEARCH_IDLE_MS } from '../../src/renderer/src/components/use-github-task-search-commit'

// Why derived: a fixed 400ms cadence left only ~150ms of margin against the idle window
// on a loaded runner, so one slow keystroke committed a prefix and failed the assertion.
const TASK_SEARCH_TYPING_DELAY_MS = Math.round(GITHUB_TASK_SEARCH_IDLE_MS / 6)
const TASK_SEARCH_SETTLE_MS = GITHUB_TASK_SEARCH_IDLE_MS + 50

type RenderedTaskSource = {
  source: string
  active: boolean
}

type TaskSearchRequestProbe = {
  countQueries: string[]
  fetchQueries: string[]
}

const TASK_SOURCE_BY_LABEL: Record<string, string> = {
  GitHub: 'github',
  GitLab: 'gitlab',
  Linear: 'linear',
  Jira: 'jira'
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

async function getRenderedTaskSources(
  page: Parameters<typeof getStoreState>[0]
): Promise<RenderedTaskSource[]> {
  return page
    .locator('[data-contextual-tour-target="tasks-source-filters"] button')
    .evaluateAll((buttons, sourceByLabel) => {
      return buttons.flatMap((button) => {
        const source =
          button.getAttribute('data-task-source') ??
          sourceByLabel[button.getAttribute('aria-label')?.trim() ?? '']
        if (!source) {
          return []
        }
        const active = button.getAttribute('aria-pressed') === 'true'
        return [{ source, active }]
      })
    }, TASK_SOURCE_BY_LABEL)
}

async function openMockedPaginatedGitHubTasks(
  page: Parameters<typeof getStoreState>[0]
): Promise<void> {
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
    const makePage = (pageNumber: number) =>
      Array.from({ length: 30 }, (_, index) => ({
        id: `issue-${pageNumber}-${index + 1}`,
        type: 'issue' as const,
        number: pageNumber * 100 + index + 1,
        title: `Issue page ${pageNumber} item ${index + 1}`,
        state: 'open' as const,
        url: `https://github.com/example/repo/issues/${pageNumber * 100 + index + 1}`,
        labels: [],
        updatedAt: new Date(1_700_000_000_000 - index * 1_000).toISOString(),
        author: 'octocat',
        repoId: repos[0]?.id ?? 'repo-1'
      }))

    store.setState({
      repos,
      getCachedWorkItems: () => makePage(1),
      prefetchWorkItems: () => {},
      fetchWorkItemsAcrossRepos: async () => ({
        items: makePage(1),
        failedCount: 0,
        githubUnavailable: false
      }),
      fetchWorkItemsNextPage: async (_repos, _perRepoLimit, _displayLimit, _query, pageNumber) => ({
        items: makePage(pageNumber),
        failedCount: 0,
        errorTypes: []
      }),
      countWorkItemsAcrossRepos: async () => ({ totalCount: 840, totalPages: 28 })
    })
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

  test('opening the tasks view renders the tasks UI', async ({ orcaPage }) => {
    await openTasksPage(orcaPage)

    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('tasks')

    await expect(orcaPage.getByRole('button', { name: 'Close tasks' })).toBeVisible({
      timeout: 10_000
    })

    // Why: source buttons are provider-availability aware in CI; assert the
    // stable Tasks chrome instead of a GitHub-only tab set.
    let renderedSources: RenderedTaskSource[] = []
    await expect
      .poll(
        async () => {
          renderedSources = await getRenderedTaskSources(orcaPage)
          return renderedSources.length
        },
        {
          timeout: 10_000,
          message: 'Tasks source controls did not render'
        }
      )
      .toBeGreaterThan(1)

    await expect
      .poll(
        async () => {
          renderedSources = await getRenderedTaskSources(orcaPage)
          return renderedSources.some((source) => source.active)
        },
        {
          timeout: 5_000,
          message: 'Active task source did not render'
        }
      )
      .toBe(true)
    if (renderedSources.some((source) => source.source === 'github' && source.active)) {
      await expect(orcaPage.getByRole('button', { name: 'Issues', exact: true })).toBeVisible()
      await expect(orcaPage.getByRole('button', { name: 'PRs', exact: true })).toBeVisible()
      await expect(orcaPage.getByRole('button', { name: 'Projects', exact: true })).toBeVisible()
      await expect(orcaPage.getByPlaceholder(/Search GitHub (issues|PRs)/i)).toBeVisible()
    }
  })

  test('closing the tasks page returns to the previous view', async ({ orcaPage }) => {
    const previousView = await getStoreState<string>(orcaPage, 'activeView')

    await openTasksPage(orcaPage)
    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('tasks')
    // Sanity: the tasks UI actually painted before we close it.
    await expect(orcaPage.getByRole('button', { name: 'Close tasks' })).toBeVisible()

    await orcaPage.getByRole('button', { name: 'Close tasks' }).click()

    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe(previousView)
    // Why: the load-bearing check is that the previous view's DOM actually
    // re-rendered — a store-only `activeView` assertion would pass even if the
    // terminal/editor surface had silently stopped mounting. `.xterm` is the
    // stable class xterm.js emits on every live terminal pane; if the
    // previous view was terminal (by far the common case in E2E setup), that
    // element must be visible. Tasks-close also hides the "Close tasks"
    // button regardless of previous view, so we assert that too.
    await expect(orcaPage.getByRole('button', { name: 'Close tasks' })).toHaveCount(0)
    if (previousView === 'terminal') {
      await expect(orcaPage.locator('.xterm').first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('reopening restores the GitHub page and scroll position', async ({ orcaPage }) => {
    await openMockedPaginatedGitHubTasks(orcaPage)

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
    await clampedRowsStyle.evaluate((element) => element.remove())
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
    await pendingRestoreStyle.evaluate((element) => element.remove())
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
    // Why the wait: outlives the 5s give-up that used to abandon the restore and
    // overwrite the remembered offset with the committed 0. A list that never paints
    // must defer the restore, never destroy the position.
    await orcaPage.waitForTimeout(5_500)
    await orcaPage.getByRole('button', { name: 'Close tasks' }).click()
    await expect
      .poll(async () => {
        const position = await getStoreState<{ scrollTop: number }>(orcaPage, 'taskListPosition')
        return position.scrollTop
      })
      .toBeGreaterThan(300)
    await permanentlyClampedRowsStyle.evaluate((element) => element.remove())
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
      .poll(async () => readTaskSearchRequestProbe(orcaPage), { timeout: 2_000 })
      .toEqual({ countQueries: ['is:issue is:open'], fetchQueries: ['is:issue is:open'] })
    await resetTaskSearchRequestProbe(orcaPage)

    await input.pressSequentially('rate', { delay: TASK_SEARCH_TYPING_DELAY_MS })

    await expect(existingIssue).toBeVisible()

    // The contract is that no prefix of the typed query is ever queried, not that the
    // probe is empty at one instant: exactly one request per surface, for the final value.
    await expect
      .poll(async () => readTaskSearchRequestProbe(orcaPage), { timeout: 2_000 })
      .toEqual({ countQueries: ['is:issue rate'], fetchQueries: ['is:issue rate'] })

    await resetTaskSearchRequestProbe(orcaPage)
    await input.pressSequentially('x')
    await input.press('Enter')

    await expect
      .poll(async () => readTaskSearchRequestProbe(orcaPage), { timeout: 2_000 })
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
