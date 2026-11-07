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

const LONG_TYPE_NAME = 'Custom story type with a name long enough to truncate'
const TYPE_ISSUE_TITLE = 'Track customer support request workflow'
const TYPE_ISSUE: JiraIssue = {
  ...ISSUE,
  id: 'layout-type-fixture',
  key: 'DEMO-102',
  title: TYPE_ISSUE_TITLE,
  issueType: { id: 'custom-story', name: LONG_TYPE_NAME }
}

async function openFixtureJiraList(page: Page, issues: JiraIssue[] = [ISSUE]): Promise<void> {
  await waitForSessionReady(page)
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.evaluate((issues) => {
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
      listJiraIssues: async () => issues,
      searchJiraIssues: async () => issues
    })
    store.getState().openTaskPage({ taskSource: 'jira' })
  }, issues)
}

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

test('Jira issue Type is an optional column that sorts and persists', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettingsOrThrow({ theme: 'light', uiLanguage: 'en' })
  })
  await orcaPage.evaluate(() => window.localStorage.removeItem('orca.jira.list-columns.v1'))
  await openFixtureJiraList(orcaPage, [ISSUE, TYPE_ISSUE])

  const title = orcaPage.getByRole('heading', { name: ISSUE_TITLE })
  await expect(title).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('jira-type-before.png') })
  await orcaPage.getByRole('button', { name: 'Columns', exact: true }).click()
  const typeOption = orcaPage.getByRole('menuitemcheckbox', { name: 'Type', exact: true })
  await expect(typeOption).toBeVisible()
  await expect(typeOption).toHaveAttribute('aria-checked', 'false')
  await typeOption.click()
  await expect(typeOption).toHaveAttribute('aria-checked', 'true')
  await orcaPage.keyboard.press('Escape')

  const setPanelWidth = (width: number) =>
    title.evaluate((element, nextWidth) => {
      const host =
        element.closest('[role="button"]')?.parentElement?.parentElement?.parentElement
          ?.parentElement?.parentElement
      if (!(host instanceof HTMLElement)) {
        throw new Error('Jira list host unavailable')
      }
      host.style.width = `${nextWidth}px`
      host.style.maxWidth = 'none'
      return host.getBoundingClientRect().width
    }, width)
  expect(await setPanelWidth(1320)).toBe(1320)

  await expect(orcaPage.getByText('Task', { exact: true })).toBeVisible()
  const longType = orcaPage.getByText(LONG_TYPE_NAME, { exact: true })
  await expect(longType).toHaveAttribute('title', LONG_TYPE_NAME)
  await orcaPage.screenshot({ path: testInfo.outputPath('jira-type-after.png') })

  for (const theme of ['dark', 'light'] as const) {
    await orcaPage.evaluate(async (nextTheme) => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: nextTheme })
    }, theme)
    await expect(orcaPage.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /\blight\b/)
    await expect(longType).toBeVisible()
  }

  const typeHeader = orcaPage.getByRole('button', {
    name: /^Type(?:, (?:ascending|descending))?$/
  })
  await expect(typeHeader).toBeVisible()
  const issueTitles = () => orcaPage.locator('[role="button"] h3').allTextContents()
  const expectedTypeOrder = async (direction: string | null) =>
    expect(await issueTitles()).toEqual(
      direction === 'Type, ascending'
        ? [TYPE_ISSUE_TITLE, ISSUE_TITLE]
        : [ISSUE_TITLE, TYPE_ISSUE_TITLE]
    )

  await typeHeader.click()
  let direction = await typeHeader.getAttribute('aria-label')
  expect(direction).toMatch(/^Type, (?:ascending|descending)$/)
  await expectedTypeOrder(direction)
  await typeHeader.click()
  direction = await typeHeader.getAttribute('aria-label')
  expect(direction).toMatch(/^Type, (?:ascending|descending)$/)
  await expectedTypeOrder(direction)

  for (const width of [500, 780, 1050, 1320]) {
    expect(await setPanelWidth(width)).toBe(width)
    const mobileSort = orcaPage.getByTestId('jira-mobile-sort-controls')
    await (width < 768 ? expect(mobileSort).toBeVisible() : expect(mobileSort).toBeHidden())
    const sortableHeader = orcaPage.getByRole('button', {
      name: /^Type(?:, (?:ascending|descending))?$/
    })
    await (width < 768 ? expect(sortableHeader).toBeHidden() : expect(sortableHeader).toBeVisible())
    if (width < 768) {
      await mobileSort.getByRole('combobox').click()
      await expect(orcaPage.getByRole('option', { name: 'Type', exact: true })).toBeVisible()
      await orcaPage.keyboard.press('Escape')
    } else {
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
      expect(grids[0].filter((_, index) => index !== 1)).toEqual(
        grids[1].filter((_, index) => index !== 1)
      )
    }
  }

  await expect
    .poll(() =>
      orcaPage.evaluate(() =>
        JSON.parse(window.localStorage.getItem('orca.jira.list-columns.v1') ?? '[]').includes(
          'type'
        )
      )
    )
    .toBe(true)
  await orcaPage.reload()
  await openFixtureJiraList(orcaPage, [ISSUE, TYPE_ISSUE])
  const reloadedTitle = orcaPage.getByRole('heading', { name: ISSUE_TITLE })
  await expect(reloadedTitle).toBeVisible()
  await reloadedTitle.evaluate((element) => {
    const host =
      element.closest('[role="button"]')?.parentElement?.parentElement?.parentElement?.parentElement
        ?.parentElement
    if (!(host instanceof HTMLElement)) {
      throw new Error('Jira list host unavailable')
    }
    host.style.width = '1320px'
  })
  await orcaPage.getByRole('button', { name: 'Columns', exact: true }).click()
  const reloadedTypeOption = orcaPage.getByRole('menuitemcheckbox', { name: 'Type', exact: true })
  await expect(reloadedTypeOption).toHaveAttribute('aria-checked', 'true')
  await reloadedTypeOption.click()
  await orcaPage.keyboard.press('Escape')
  await expect(
    orcaPage.getByRole('button', { name: /^Updated(?:, (?:ascending|descending))?$/ })
  ).toHaveAttribute('aria-pressed', 'true')
})
