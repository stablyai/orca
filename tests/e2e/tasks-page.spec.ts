/**
 * E2E tests for the Tasks page.
 *
 * Verifies that opening the tasks view renders correctly and that the
 * source controls and close affordance are present.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, getStoreState } from './helpers/store'

type RenderedTaskSource = {
  source: string
  active: boolean
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
})
