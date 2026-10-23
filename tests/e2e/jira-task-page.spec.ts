/**
 * E2E tests for the Jira source of the Tasks page (browse + open an issue).
 *
 * Why E2E: browsing and the issue detail workspace cross the main-process IPC
 * boundary (`jira:status`, `jira:listIssues`, `jira:searchIssues`,
 * `jira:getIssue`, `jira:issueComments`, `jira:updateIssue`) and render the
 * real list chrome, rows, and detail sheet. A store-slice unit test cannot
 * prove the stubbed backend's answers reach that UI, so every Jira handler is
 * overridden in the main process and every final assertion targets a rendered
 * element. `window.__store` is used only to reach the Jira task page.
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type {
  JiraComment,
  JiraConnectionStatus,
  JiraIssue,
  JiraPriority,
  JiraProject,
  JiraSite,
  JiraTransition,
  JiraUser,
  JiraViewer
} from '../../src/shared/jira-types'

const JIRA_SEARCH_PLACEHOLDER = 'Search issues or enter JQL, e.g. project = ABC'
const SITE_ACME: JiraSite = {
  id: 'jira-site-acme',
  siteUrl: 'https://acme.atlassian.net',
  email: 'e2e@acme.test',
  displayName: 'Acme Jira',
  accountId: 'acct-acme'
}
const SITE_BRAVO: JiraSite = {
  id: 'jira-site-bravo',
  siteUrl: 'https://bravo.atlassian.net',
  email: 'e2e@bravo.test',
  displayName: 'Bravo Jira',
  accountId: 'acct-bravo'
}
const VIEWER: JiraViewer = {
  accountId: 'acct-acme',
  displayName: 'Jira E2E User',
  email: 'e2e@acme.test'
}
const STATUS = {
  todo: { id: 'jira-status-todo', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  inProgress: {
    id: 'jira-status-in-progress',
    name: 'In Progress',
    categoryKey: 'indeterminate',
    categoryName: 'In Progress'
  },
  done: { id: 'jira-status-done', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
} as const
const PROJECT_RDG: JiraProject = {
  id: 'jira-project-rdg',
  key: 'RDG',
  name: 'Roadmap',
  siteId: SITE_ACME.id,
  siteName: SITE_ACME.displayName
}
const ISSUE_MIGRATE_DESCRIPTION = 'Rebuild the marketing homepage on the component library.'
const ISSUE_MIGRATE: JiraIssue = {
  id: 'jira-issue-344',
  key: 'RDG-344',
  siteId: SITE_ACME.id,
  siteName: SITE_ACME.displayName,
  title: 'Migrate homepage from NuxtJS to NextJS',
  description: ISSUE_MIGRATE_DESCRIPTION,
  url: 'https://acme.atlassian.net/browse/RDG-344',
  project: PROJECT_RDG,
  issueType: { id: 'jira-type-story', name: 'Story' },
  status: STATUS.todo,
  labels: ['frontend'],
  assignee: { accountId: 'u-ada', displayName: 'Ada Lovelace' },
  priority: { id: 'p-high', name: 'High' },
  updatedAt: '2026-08-04T18:00:00.000Z',
  createdAt: '2026-07-01T09:00:00.000Z'
}
const ISSUE_CACHE: JiraIssue = {
  ...ISSUE_MIGRATE,
  id: 'jira-issue-345',
  key: 'RDG-345',
  title: 'Trim the stale issue cache on startup',
  description: 'Drop cache entries older than the refresh window.',
  url: 'https://acme.atlassian.net/browse/RDG-345',
  status: STATUS.inProgress,
  labels: [],
  assignee: undefined
}
const ISSUE_SEARCH_HIT: JiraIssue = {
  ...ISSUE_MIGRATE,
  id: 'jira-issue-777',
  key: 'RDG-777',
  title: 'Only matched by a JQL search',
  description: 'Surfaced by the project-scoped query.',
  url: 'https://acme.atlassian.net/browse/RDG-777',
  status: STATUS.done,
  labels: []
}
const COMMENT_ONE: JiraComment = {
  id: 'jira-comment-1',
  body: 'Reproduced on staging too.',
  createdAt: '2026-08-04T19:00:00.000Z',
  user: { accountId: 'u-linus', displayName: 'Linus Torvalds' }
}
const COMMENT_TWO: JiraComment = {
  id: 'jira-comment-2',
  body: 'Raised the priority after the incident.',
  createdAt: '2026-08-04T20:00:00.000Z',
  user: { accountId: 'u-grace', displayName: 'Grace Hopper' }
}
const TRANSITION_DONE: JiraTransition = {
  id: 'jira-transition-done',
  name: 'Done',
  to: STATUS.done
}

type JiraE2EFixture = {
  status: JiraConnectionStatus
  projects: JiraProject[]
  issues: JiraIssue[]
  searchIssues: JiraIssue[]
  issue: JiraIssue
  comments: JiraComment[]
  transitions: JiraTransition[]
  priorities: JiraPriority[]
  users: JiraUser[]
}

const FIXTURE: JiraE2EFixture = {
  status: {
    connected: true,
    viewer: VIEWER,
    sites: [SITE_ACME, SITE_BRAVO],
    activeSiteId: SITE_ACME.id,
    selectedSiteId: SITE_ACME.id
  },
  projects: [PROJECT_RDG],
  issues: [ISSUE_MIGRATE, ISSUE_CACHE],
  searchIssues: [ISSUE_SEARCH_HIT],
  issue: ISSUE_MIGRATE,
  comments: [COMMENT_ONE, COMMENT_TWO],
  transitions: [TRANSITION_DONE],
  priorities: [{ id: 'p-high', name: 'High' }],
  users: [{ accountId: 'u-ada', displayName: 'Ada Lovelace' }]
}

type JiraListCall = { filter?: string; limit?: number; siteId?: string }
type JiraSearchCall = { jql: string; limit?: number; siteId?: string }
type JiraKeyCall = { key: string }
type JiraUpdateCall = { key: string; updates: { transitionId?: string } }

type JiraE2ECalls = {
  listIssues: JiraListCall[]
  searchIssues: JiraSearchCall[]
  getIssue: JiraKeyCall[]
  issueComments: JiraKeyCall[]
  updateIssue: JiraUpdateCall[]
}

/** Overrides every Jira IPC handler the Tasks page reads with a scripted backend. */
async function installJiraBackend(
  app: ElectronApplication,
  fixture: JiraE2EFixture
): Promise<void> {
  await app.evaluate(({ ipcMain }, data) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spec-private main-process call log; only this spec's IPC stubs write and read it.
    const g = globalThis as unknown as {
      __jiraE2ECalls?: JiraE2ECalls
      __jiraE2EIssue?: JiraIssue
    }
    const calls: JiraE2ECalls = {
      listIssues: [],
      searchIssues: [],
      getIssue: [],
      issueComments: [],
      updateIssue: []
    }
    g.__jiraE2ECalls = calls
    g.__jiraE2EIssue = data.issue

    const register = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, listener)
    }

    register('jira:status', () => data.status)
    register('jira:readStatus', () => data.status)
    register('jira:listProjects', () => data.projects)
    register('jira:getProjectStatusOrder', () => ({ statusIdsByColumn: [] }))

    register('jira:listIssues', (_event: unknown, args?: JiraListCall) => {
      calls.listIssues.push({ filter: args?.filter, limit: args?.limit, siteId: args?.siteId })
      return data.issues
    })

    register('jira:searchIssues', (_event: unknown, args?: JiraSearchCall) => {
      calls.searchIssues.push({ jql: args?.jql ?? '', limit: args?.limit, siteId: args?.siteId })
      return data.searchIssues
    })
    register('jira:cancelSearchIssues', () => undefined)

    register('jira:getIssue', (_event: unknown, args: { key: string }) => {
      calls.getIssue.push({ key: args.key })
      return g.__jiraE2EIssue ?? null
    })

    register('jira:listTransitions', () => data.transitions)
    register('jira:listPriorities', () => data.priorities)
    register('jira:listAssignableUsers', () => data.users)

    register('jira:issueComments', (_event: unknown, args: { key: string }) => {
      calls.issueComments.push({ key: args.key })
      return data.comments
    })

    register('jira:updateIssue', (_event: unknown, args: JiraUpdateCall) => {
      calls.updateIssue.push({
        key: args.key,
        updates: { transitionId: args.updates?.transitionId }
      })
      const transition = args.updates?.transitionId
        ? data.transitions.find((candidate) => candidate.id === args.updates.transitionId)
        : undefined
      if (g.__jiraE2EIssue && transition) {
        g.__jiraE2EIssue = { ...g.__jiraE2EIssue, status: transition.to }
      }
      return { ok: true }
    })
  }, fixture)
}

async function readJiraCalls(app: ElectronApplication): Promise<JiraE2ECalls> {
  return app.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the spec-private main-process call log its IPC stubs wrote.
    const g = globalThis as unknown as { __jiraE2ECalls?: JiraE2ECalls }
    if (!g.__jiraE2ECalls) {
      throw new Error('Jira E2E backend was not installed')
    }
    return g.__jiraE2ECalls
  })
}

async function resetJiraCalls(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the spec-private main-process call log its IPC stubs wrote.
    const g = globalThis as unknown as { __jiraE2ECalls?: JiraE2ECalls }
    if (!g.__jiraE2ECalls) {
      return
    }
    g.__jiraE2ECalls.listIssues = []
    g.__jiraE2ECalls.searchIssues = []
    g.__jiraE2ECalls.getIssue = []
    g.__jiraE2ECalls.issueComments = []
    g.__jiraE2ECalls.updateIssue = []
  })
}

async function openJiraTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettings({ uiLanguage: 'en' })
    // Why: the app already checked Jira status against the real backend during boot,
    // so the mount effect is a no-op unless we re-read through the freshly stubbed handlers.
    await store.getState().checkJiraConnection()
    store.getState().openTaskPage({ taskSource: 'jira' })
  })
}

function issueRow(page: Page, title: string) {
  return page.getByText(title, { exact: true })
}

// The transition popover also exposes role="dialog"; scope to the sheet so its trigger is unambiguous.
function jiraDetailSheet(page: Page) {
  return page.locator('[data-slot="sheet-content"]')
}

test.describe('Jira task page', () => {
  test.beforeEach(async ({ orcaPage, electronApp }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await installJiraBackend(electronApp, FIXTURE)
    await openJiraTasks(orcaPage)
    await expect
      .poll(() => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('tasks')
  })

  test('renders the Jira list chrome and issue rows from the connected site', async ({
    orcaPage,
    electronApp
  }) => {
    await expect(orcaPage.getByPlaceholder(JIRA_SEARCH_PLACEHOLDER)).toBeVisible({
      timeout: 20_000
    })
    await expect(orcaPage.getByText('Jira issues', { exact: true })).toBeVisible()
    // Two stubbed sites make the site picker render; its trigger shows the active site.
    await expect(orcaPage.getByText(SITE_ACME.displayName, { exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Refresh Jira issues' })).toBeVisible()

    await expect(issueRow(orcaPage, ISSUE_MIGRATE.title)).toBeVisible({ timeout: 20_000 })
    await expect(issueRow(orcaPage, ISSUE_CACHE.title)).toBeVisible()
    await expect(orcaPage.getByText(ISSUE_MIGRATE.key, { exact: true }).first()).toBeVisible()

    const calls = await readJiraCalls(electronApp)
    const listed = calls.listIssues.some(
      (call) => call.filter === 'assigned' && call.limit === 50 && call.siteId === SITE_ACME.id
    )
    expect(listed).toBe(true)
  })

  test('opening an issue shows its summary and description', async ({ orcaPage }) => {
    await issueRow(orcaPage, ISSUE_MIGRATE.title).click()

    const sheet = jiraDetailSheet(orcaPage)
    await expect(sheet).toBeVisible({ timeout: 10_000 })
    await expect(sheet.getByText(ISSUE_MIGRATE.key, { exact: true })).toBeVisible()
    // The seeded title input is the editable summary; the Sheet title is visually hidden.
    await expect(sheet.locator('input').first()).toHaveValue(ISSUE_MIGRATE.title)
    await expect(sheet.getByText(ISSUE_MIGRATE_DESCRIPTION, { exact: true })).toBeVisible()
  })

  test('renders issue comments after the comments request resolves', async ({
    orcaPage,
    electronApp
  }) => {
    await issueRow(orcaPage, ISSUE_MIGRATE.title).click()

    const sheet = jiraDetailSheet(orcaPage)
    await expect(sheet.getByText(COMMENT_ONE.body, { exact: true })).toBeVisible({
      timeout: 10_000
    })
    await expect(sheet.getByText(COMMENT_TWO.body, { exact: true })).toBeVisible()
    await expect(sheet.getByText(COMMENT_ONE.user!.displayName, { exact: true })).toBeVisible()

    const calls = await readJiraCalls(electronApp)
    expect(calls.issueComments.some((call) => call.key === ISSUE_MIGRATE.key)).toBe(true)
  })

  test('searching issues re-queries the backend and swaps the rendered rows', async ({
    orcaPage,
    electronApp
  }) => {
    await expect(issueRow(orcaPage, ISSUE_MIGRATE.title)).toBeVisible({ timeout: 20_000 })
    await resetJiraCalls(electronApp)

    const input = orcaPage.getByPlaceholder(JIRA_SEARCH_PLACEHOLDER)
    await input.fill('project = RDG')
    await expect(input).toHaveValue('project = RDG')
    await input.press('Enter')

    await expect(issueRow(orcaPage, ISSUE_SEARCH_HIT.title)).toBeVisible({ timeout: 10_000 })
    await expect(issueRow(orcaPage, ISSUE_MIGRATE.title)).toHaveCount(0)
    await expect(issueRow(orcaPage, ISSUE_CACHE.title)).toHaveCount(0)

    await expect
      .poll(async () => (await readJiraCalls(electronApp)).searchIssues.map((call) => call.jql), {
        timeout: 5_000
      })
      .toContain('project = RDG')
    const calls = await readJiraCalls(electronApp)
    expect(calls.searchIssues.at(-1)).toMatchObject({
      jql: 'project = RDG',
      limit: 50,
      siteId: SITE_ACME.id
    })
  })

  test('changing status through a transition updates the issue detail', async ({
    orcaPage,
    electronApp
  }) => {
    await issueRow(orcaPage, ISSUE_MIGRATE.title).click()

    const sheet = jiraDetailSheet(orcaPage)
    const statusTrigger = sheet.getByRole('button', { name: STATUS.todo.name, exact: true })
    await expect(statusTrigger).toBeVisible({ timeout: 10_000 })
    await statusTrigger.click()

    const popover = orcaPage.locator('[data-slot="popover-content"]')
    await expect(popover).toBeVisible()
    await popover.getByRole('button', { name: TRANSITION_DONE.name, exact: true }).click()

    await expect
      .poll(async () => (await readJiraCalls(electronApp)).updateIssue, { timeout: 10_000 })
      .toEqual([{ key: ISSUE_MIGRATE.key, updates: { transitionId: TRANSITION_DONE.id } }])

    // Close the popover so only the detail sheet remains a dialog.
    await orcaPage.keyboard.press('Escape')
    await expect(sheet.getByRole('button', { name: STATUS.done.name, exact: true })).toBeVisible({
      timeout: 10_000
    })
  })
})
