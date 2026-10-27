import type { Page } from '@stablyai/playwright-test'
import type { JiraIssue } from '../../src/shared/jira/jira-types'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const ISSUE_TITLE = 'Keep planning notes visible while switching between project tasks'
const ISSUE: JiraIssue = {
  id: 'layout-fixture',
  key: 'DEMO-101',
  siteId: 'layout-site',
  title: ISSUE_TITLE,
  url: 'https://example.atlassian.net/browse/DEMO-101',
  project: { id: 'layout-project', key: 'DEMO', name: 'Demo' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'open', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  parent: { key: 'DEMO-10', title: 'Epic planning' },
  sprint: 'Sprint 12',
  storyPoints: 5,
  originalEstimateSeconds: 7200,
  remainingEstimateSeconds: 1800,
  priority: { id: 'high', name: 'High' },
  assignee: { accountId: 'layout-user', displayName: 'Demo User' },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z'
}

async function openFixtureJiraList(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.evaluate((issue) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    if (!state.settings) {
      throw new Error('Settings unavailable')
    }
    const status = {
      connected: true,
      viewer: null,
      selectedSiteId: 'layout-site',
      sites: [
        {
          id: 'layout-site',
          siteUrl: 'https://example.atlassian.net',
          email: '',
          displayName: 'Demo Jira',
          accountId: 'layout-user'
        }
      ]
    }
    store.setState({
      settings: { ...state.settings, defaultTaskSource: 'jira', visibleTaskProviders: ['jira'] },
      jiraStatus: status,
      jiraStatusChecked: true,
      jiraStatusContextKey: 'local#0',
      checkJiraConnection: async () => {},
      readJiraStatus: async () => status,
      listJiraIssues: async () => [issue],
      searchJiraIssues: async () => [issue]
    })
    store.getState().openTaskPage({ taskSource: 'jira' })
  }, ISSUE)
}

test('Jira titles and sort headings adapt to panel width inside a wide window', async ({
  orcaPage
}) => {
  await openFixtureJiraList(orcaPage)

  const title = orcaPage.getByRole('heading', { name: ISSUE_TITLE })
  await expect(title).toBeVisible()
  let previousDesktopTitleWidth: number | null = null
  for (const width of [500, 780, 1050, 1320]) {
    const panelWidth = await title.evaluate((element, width) => {
      const host =
        element.closest('[role="button"]')?.parentElement?.parentElement?.parentElement
          ?.parentElement?.parentElement
      if (!(host instanceof HTMLElement)) {
        throw new Error('Jira list host unavailable')
      }
      host.style.width = `${width}px`
      host.style.maxWidth = 'none'
      return host.getBoundingClientRect().width
    }, width)
    expect(panelWidth).toBe(width)
    const titleWidthExpectation = expect.poll(() =>
      title.evaluate((element) => element.getBoundingClientRect().width)
    )
    await (width === 780
      ? titleWidthExpectation.toBeGreaterThanOrEqual(180)
      : titleWidthExpectation.toBeGreaterThan(200))
    const mobileSort = orcaPage.getByTestId('jira-mobile-sort-controls')
    const assignee = orcaPage.getByRole('button', { name: 'Assignee', exact: true })
    await (width < 768 ? expect(mobileSort).toBeVisible() : expect(mobileSort).toBeHidden())
    await (width >= 1024 ? expect(assignee).toBeVisible() : expect(assignee).toBeHidden())
    if (width >= 768) {
      const grids = await title.evaluate((element) => {
        const row = element.closest('[role="button"]')
        const host = row?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement
        const header = host?.querySelector('button[aria-pressed]')?.parentElement
        if (!row || !header) {
          throw new Error('Jira header or row unavailable')
        }
        return [
          getComputedStyle(row).gridTemplateColumns.split(' '),
          getComputedStyle(header).gridTemplateColumns.split(' ')
        ]
      })
      // The scroll gutter narrows the flexible title; fixed tracks must still match.
      expect(grids[0].filter((_, index) => index !== 1)).toEqual(
        grids[1].filter((_, index) => index !== 1)
      )
      const titleWidth = await title.evaluate((element) => element.getBoundingClientRect().width)
      if (previousDesktopTitleWidth !== null) {
        expect(titleWidth).toBeGreaterThan(previousDesktopTitleWidth)
      }
      previousDesktopTitleWidth = titleWidth
    }
  }
})

test('Jira planning columns persist and hiding a sorted field selects a visible fallback', async ({
  orcaPage
}) => {
  await openFixtureJiraList(orcaPage)
  const title = orcaPage.getByRole('heading', { name: ISSUE_TITLE })
  await expect(title).toBeVisible()
  await title.evaluate((element) => {
    const host =
      element.closest('[role="button"]')?.parentElement?.parentElement?.parentElement?.parentElement
        ?.parentElement
    if (!(host instanceof HTMLElement)) {
      throw new Error('Jira list host unavailable')
    }
    host.style.width = '780px'
  })
  await orcaPage.getByRole('button', { name: 'Columns', exact: true }).click()
  for (const name of ['Parent', 'Sprint', 'Points', 'Estimate', 'Remaining']) {
    await orcaPage.getByRole('menuitemcheckbox', { name, exact: true }).click()
  }
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByText('Epic planning', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Sprint 12', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('2h', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('30m', { exact: true })).toBeVisible()
  const layout = await title.evaluate((element) => {
    const row = element.closest('[role="button"]')
    const scroll = row?.parentElement?.parentElement?.parentElement?.parentElement
    if (!(scroll instanceof HTMLElement)) {
      throw new Error('Scroll container unavailable')
    }
    return {
      title: element.getBoundingClientRect().width,
      content: scroll.scrollWidth,
      viewport: scroll.clientWidth
    }
  })
  expect(layout.title).toBeGreaterThanOrEqual(180)
  expect(layout.content).toBeGreaterThan(layout.viewport)
  await orcaPage.getByRole('button', { name: 'Points', exact: true }).click()
  await expect(orcaPage.getByRole('button', { name: 'Points, ascending' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await orcaPage.getByRole('button', { name: 'Columns', exact: true }).click()
  await orcaPage.getByRole('menuitemcheckbox', { name: 'Points', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByRole('button', { name: 'Updated, descending' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await orcaPage.reload()
  await openFixtureJiraList(orcaPage)
  await orcaPage.getByRole('button', { name: 'Columns', exact: true }).click()
  await expect(
    orcaPage.getByRole('menuitemcheckbox', { name: 'Sprint', exact: true })
  ).toHaveAttribute('aria-checked', 'true')
  await expect(
    orcaPage.getByRole('menuitemcheckbox', { name: 'Points', exact: true })
  ).toHaveAttribute('aria-checked', 'false')
})
