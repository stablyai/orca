/**
 * E2E: creating a Jira issue from the Tasks page, plus the provider-backed pickers around it.
 *
 * Mocks the main-process `jira:*` IPC handlers (pattern from linear-filter-chip-labels.spec.ts)
 * so the renderer exercises its real dialog, metadata loading, submit path, and detail pickers
 * with no network.
 *
 * Flows: (1) the affordance opens the create dialog with its fields; (2) the project picker
 * lists `jira:listProjects` and loads issue types + required create fields for the choice;
 * (3) submitting calls `jira:createIssue` with the typed values and the issue lands in the
 * list; (4) an empty summary keeps the dialog open and creates nothing; (5) the issue-detail
 * priority/assignee pickers render `jira:listPriorities` / `jira:listAssignableUsers` options
 * (the create dialog itself has no priority/assignee controls).
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type {
  JiraCreateField,
  JiraIssue,
  JiraIssueType,
  JiraPriority,
  JiraProject,
  JiraSite,
  JiraStatus,
  JiraTransition,
  JiraUser
} from '../../src/shared/jira-types'

const SITE_ID = 'jira-site-e2e'

const SITE: JiraSite = {
  id: SITE_ID,
  siteUrl: 'https://e2e.atlassian.net',
  email: 'jira-e2e@example.test',
  displayName: 'E2E Site',
  accountId: 'acct-1'
}

const PROJECTS: JiraProject[] = [
  { id: '10000', key: 'ENG', name: 'Engineering', siteId: SITE_ID, siteName: SITE.displayName },
  { id: '10001', key: 'OPS', name: 'Operations', siteId: SITE_ID, siteName: SITE.displayName }
]

const ENG = PROJECTS[0]

const ISSUE_TYPES_BY_PROJECT: Record<string, JiraIssueType[]> = {
  '10000': [
    { id: '10001', name: 'Task' },
    { id: '10002', name: 'Bug' }
  ],
  '10001': [{ id: '10003', name: 'Task' }]
}

// Why: OPS requires an extra field so flow 2 can prove `jira:listCreateFields` is
// rendered; ENG (the auto-selected default) stays field-free so submit works.
const CREATE_FIELDS_BY_PROJECT: Record<string, JiraCreateField[]> = {
  '10000': [],
  '10001': [
    {
      key: 'customfield_10020',
      name: 'Severity',
      required: true,
      schema: { type: 'option' },
      allowedValues: [
        { id: 'sev-high', value: 'High' },
        { id: 'sev-low', value: 'Low' }
      ]
    }
  ]
}

const PRIORITIES: JiraPriority[] = [
  { id: 'prio-1', name: 'Highest' },
  { id: 'prio-2', name: 'Low' },
  { id: 'prio-3', name: 'Medium' }
]

const ASSIGNABLE_USERS: JiraUser[] = [
  { accountId: 'acct-2', displayName: 'Ada Assignee', email: 'ada@example.test' }
]

const STATUS: JiraStatus = {
  id: 'status-todo',
  name: 'To Do',
  categoryKey: 'new',
  categoryName: 'To Do'
}

const EXISTING_ISSUE: JiraIssue = {
  id: 'existing-1',
  key: 'ENG-7',
  siteId: SITE_ID,
  siteName: SITE.displayName,
  title: 'Existing seeded Jira issue',
  url: 'https://e2e.atlassian.net/browse/ENG-7',
  project: ENG,
  issueType: { id: '10001', name: 'Task' },
  status: STATUS,
  labels: [],
  priority: PRIORITIES[2],
  updatedAt: '2026-09-01T12:00:00.000Z',
  createdAt: '2026-08-01T12:00:00.000Z'
}

const CREATED_KEY = 'ENG-99'

type JiraCreateArgs = {
  siteId?: string
  projectId: string
  issueTypeId: string
  title: string
  description?: string
}

type JiraCreateProbe = {
  createArgs: JiraCreateArgs | null
}

type JiraProbeGlobal = typeof globalThis & { __orcaE2EJiraCreateProbe?: JiraCreateProbe }

const JIRA_FIXTURE = {
  site: SITE,
  projects: PROJECTS,
  issueTypesByProject: ISSUE_TYPES_BY_PROJECT,
  createFieldsByProject: CREATE_FIELDS_BY_PROJECT,
  priorities: PRIORITIES,
  assignableUsers: ASSIGNABLE_USERS,
  transitions: [] satisfies JiraTransition[],
  existingIssues: [EXISTING_ISSUE],
  createdProject: ENG,
  createdIssueType: { id: '10001', name: 'Task' } satisfies JiraIssueType,
  status: STATUS,
  createdKey: CREATED_KEY,
  updatedAt: '2026-09-10T12:00:00.000Z'
}

async function installJiraBackend(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, fixture) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spec-private main-process probe global; only this spec's stubs write and read it.
    const scope = globalThis as JiraProbeGlobal
    const probe: JiraCreateProbe = { createArgs: null }
    scope.__orcaE2EJiraCreateProbe = probe

    let createdIssue: JiraIssue | null = null

    const status = {
      connected: true,
      viewer: {
        accountId: fixture.site.accountId,
        displayName: 'Jira E2E User',
        email: fixture.site.email
      },
      sites: [fixture.site],
      activeSiteId: fixture.site.id,
      selectedSiteId: fixture.site.id
    }
    ipcMain.removeHandler('jira:status')
    ipcMain.handle('jira:status', async () => status)
    ipcMain.removeHandler('jira:readStatus')
    ipcMain.handle('jira:readStatus', async () => status)

    ipcMain.removeHandler('jira:listProjects')
    ipcMain.handle('jira:listProjects', async () => fixture.projects)

    ipcMain.removeHandler('jira:listIssueTypes')
    ipcMain.handle(
      'jira:listIssueTypes',
      async (_event, args) => fixture.issueTypesByProject[args?.projectIdOrKey] ?? []
    )

    ipcMain.removeHandler('jira:listCreateFields')
    ipcMain.handle(
      'jira:listCreateFields',
      async (_event, args) => fixture.createFieldsByProject[args?.projectIdOrKey] ?? []
    )

    ipcMain.removeHandler('jira:listPriorities')
    ipcMain.handle('jira:listPriorities', async () => fixture.priorities)

    ipcMain.removeHandler('jira:listAssignableUsers')
    ipcMain.handle('jira:listAssignableUsers', async () => fixture.assignableUsers)

    ipcMain.removeHandler('jira:listTransitions')
    ipcMain.handle('jira:listTransitions', async () => fixture.transitions)

    ipcMain.removeHandler('jira:issueComments')
    ipcMain.handle('jira:issueComments', async () => [])

    ipcMain.removeHandler('jira:listIssues')
    ipcMain.handle('jira:listIssues', async () =>
      createdIssue ? [createdIssue, ...fixture.existingIssues] : fixture.existingIssues
    )

    ipcMain.removeHandler('jira:searchIssues')
    ipcMain.handle('jira:searchIssues', async () =>
      createdIssue ? [createdIssue, ...fixture.existingIssues] : fixture.existingIssues
    )

    ipcMain.removeHandler('jira:getIssue')
    ipcMain.handle('jira:getIssue', async (_event, args) => {
      if (createdIssue && args?.key === createdIssue.key) {
        return createdIssue
      }
      return fixture.existingIssues.find((issue) => issue.key === args?.key) ?? null
    })

    ipcMain.removeHandler('jira:createIssue')
    ipcMain.handle('jira:createIssue', async (_event, args) => {
      probe.createArgs = {
        siteId: args?.siteId,
        projectId: args?.projectId,
        issueTypeId: args?.issueTypeId,
        title: args?.title,
        description: args?.description
      }
      createdIssue = {
        id: 'created-1',
        key: fixture.createdKey,
        siteId: fixture.site.id,
        siteName: fixture.site.displayName,
        title: args?.title ?? '',
        description: args?.description,
        url: `https://e2e.atlassian.net/browse/${fixture.createdKey}`,
        project: fixture.createdProject,
        issueType: fixture.createdIssueType,
        status: fixture.status,
        labels: [],
        priority: fixture.priorities[2],
        updatedAt: fixture.updatedAt,
        createdAt: fixture.updatedAt
      }
      return {
        ok: true as const,
        id: createdIssue.id,
        key: createdIssue.key,
        url: createdIssue.url
      }
    })
  }, JIRA_FIXTURE)
}

async function readCreateProbe(electronApp: ElectronApplication): Promise<JiraCreateProbe> {
  return electronApp.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the spec-private main-process probe global its stubs wrote.
    const scope = globalThis as JiraProbeGlobal
    return { createArgs: scope.__orcaE2EJiraCreateProbe?.createArgs ?? null }
  })
}

async function openJiraTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: this spec asserts on English labels; the host may run another locale.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    await store.getState().checkJiraConnection()
    store.getState().openTaskPage({ taskSource: 'jira' })
  })
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeView), { timeout: 10_000 })
    .toBe('tasks')
  await expect(page.getByRole('button', { name: 'Close tasks' })).toBeVisible({ timeout: 10_000 })
}

function jiraDialog(page: Page) {
  return page.getByRole('dialog', { name: 'New Jira issue' })
}

async function openJiraCreateDialog(page: Page): Promise<void> {
  await openJiraTasks(page)
  const createIssueAffordance = page.getByRole('button', { name: 'New Jira issue' })
  // The affordance stays disabled until the project list resolves.
  await expect(createIssueAffordance).toBeEnabled({ timeout: 15_000 })
  await createIssueAffordance.click()
  await expect(jiraDialog(page)).toBeVisible()
}

test.describe('Jira issue creation from the Tasks page', () => {
  test.beforeEach(async ({ orcaPage, electronApp }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await installJiraBackend(electronApp)
  })

  test('opens the create dialog with project, issue type, summary, and description', async ({
    orcaPage
  }) => {
    await openJiraCreateDialog(orcaPage)

    const dialog = jiraDialog(orcaPage)
    await expect(dialog.getByText('Project', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Issue type', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Title', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Description (optional)', { exact: true })).toBeVisible()
    await expect(dialog.getByPlaceholder('Short summary')).toBeVisible()
    await expect(dialog.getByPlaceholder("What's going on?")).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create issue' })).toBeVisible()
  })

  test('project picker lists projects and loads issue types plus create fields', async ({
    orcaPage
  }) => {
    await openJiraCreateDialog(orcaPage)
    const dialog = jiraDialog(orcaPage)

    // The dialog preselects the first project, so opening the picker shows the list.
    await dialog.getByRole('combobox').first().click()
    const projectPopover = orcaPage.locator('[data-slot="popover-content"]')
    await expect(projectPopover.getByText('Engineering (ENG)', { exact: true })).toBeVisible()
    await expect(projectPopover.getByText('Operations (OPS)', { exact: true })).toBeVisible()

    await projectPopover.getByText('Operations (OPS)', { exact: true }).click()

    // Issue types come from jira:listIssueTypes for the chosen project.
    await expect(dialog.getByRole('combobox').nth(1)).toContainText('Task')

    // Required create fields from jira:listCreateFields render in the form.
    await expect(dialog.getByText('Severity', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Select Severity', { exact: true })).toBeVisible()
  })

  test('submitting calls jira:createIssue with typed values and shows the new issue', async ({
    orcaPage,
    electronApp
  }) => {
    await openJiraCreateDialog(orcaPage)
    const dialog = jiraDialog(orcaPage)

    // Why: the dialog auto-selects project + issue type, but the submit button stays
    // disabled until a non-empty title is typed, so fill the fields before asserting.
    await dialog.getByPlaceholder('Short summary').fill('Created from Tasks E2E')
    await dialog.getByPlaceholder("What's going on?").fill('Typed in the E2E spec')

    const submit = dialog.getByRole('button', { name: 'Create issue' })
    await expect(submit).toBeEnabled({ timeout: 10_000 })
    await submit.click()

    await expect(dialog).toBeHidden({ timeout: 10_000 })
    // Why: creation auto-selects the new issue, opening the detail sheet; scope to
    // the list row's heading so the sheet's copy of the title cannot collide.
    await expect(orcaPage.locator('h3').filter({ hasText: 'Created from Tasks E2E' })).toBeVisible()

    await expect
      .poll(async () => (await readCreateProbe(electronApp)).createArgs)
      .toEqual({
        siteId: SITE_ID,
        projectId: ENG.id,
        issueTypeId: '10001',
        title: 'Created from Tasks E2E',
        description: 'Typed in the E2E spec'
      })
  })

  test('an empty summary keeps the dialog open and creates nothing', async ({
    orcaPage,
    electronApp
  }) => {
    await openJiraCreateDialog(orcaPage)
    const dialog = jiraDialog(orcaPage)
    const summary = dialog.getByPlaceholder('Short summary')
    const submit = dialog.getByRole('button', { name: 'Create issue' })

    // Whitespace-only summary is still empty after trimming.
    await summary.fill('   ')
    await expect(submit).toBeDisabled()

    // Enter is a submit path; the guard must reject the empty title.
    await summary.press('Enter')

    await expect(dialog).toBeVisible()
    expect((await readCreateProbe(electronApp)).createArgs).toBeNull()
  })

  test('issue detail priority and assignee pickers render provider options', async ({
    orcaPage
  }) => {
    await openJiraTasks(orcaPage)

    await orcaPage.getByText(EXISTING_ISSUE.title, { exact: true }).click()
    const sheet = orcaPage.locator('[data-slot="sheet-content"]')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Close Jira issue preview' })).toBeVisible()

    // Priority options come from jira:listPriorities.
    await sheet.getByRole('button', { name: 'Medium' }).click()
    const priorityPopover = orcaPage.locator('[data-slot="popover-content"]')
    await expect(priorityPopover.getByText('Highest', { exact: true })).toBeVisible()
    await expect(priorityPopover.getByText('Low', { exact: true })).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.locator('[data-slot="popover-content"]')).toHaveCount(0)

    // Assignee options come from jira:listAssignableUsers.
    await sheet.getByRole('button', { name: '+ Assignee' }).click()
    const assigneePopover = orcaPage.locator('[data-slot="popover-content"]')
    await expect(assigneePopover.getByText('Ada Assignee', { exact: true })).toBeVisible()
  })
})
