/**
 * Linear board, custom-view, and project-overview E2E, backed by mocked main-process IPC.
 *
 * These surfaces are only reachable from the Tasks page once Linear is connected: the
 * status board groups issues into state columns, the Views tab lists saved custom views
 * and opens their issue/project contents, the Projects tab opens an overview with
 * progress/lead/status, the scope selector switches workspace and re-queries issues, and
 * dropping a board card across columns mutates the issue state.
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type UiState = { name: string; type: string; color: string }
type WorkflowState = UiState & { id: string; position: number }
type TeamFixture = {
  id: string
  workspaceId: string
  workspaceName: string
  name: string
  key: string
}
type BackendLog = {
  listIssues: { workspaceId?: string }[]
  listTeams: { workspaceId?: string }[]
  updateIssue: { id: string; stateId?: string }[]
}

const WORKSPACE_A = {
  id: 'linear-ws-alpha',
  displayName: 'Alpha User',
  email: null,
  organizationId: 'linear-org-alpha',
  organizationName: 'Alpha Workspace'
}
const WORKSPACE_B = {
  id: 'linear-ws-beta',
  displayName: 'Beta User',
  email: null,
  organizationId: 'linear-org-beta',
  organizationName: 'Beta Workspace'
}
const TEAM_A: TeamFixture = {
  id: 'linear-team-eng',
  workspaceId: WORKSPACE_A.id,
  workspaceName: WORKSPACE_A.organizationName,
  name: 'Engineering',
  key: 'ENG'
}
const TEAM_B: TeamFixture = {
  id: 'linear-team-prod',
  workspaceId: WORKSPACE_B.id,
  workspaceName: WORKSPACE_B.organizationName,
  name: 'Product',
  key: 'PROD'
}

const STATE_TODO: WorkflowState = {
  id: 'linear-state-todo',
  name: 'Todo',
  type: 'unstarted',
  color: '#777777',
  position: 0
}
const STATE_IN_PROGRESS: WorkflowState = {
  id: 'linear-state-in-progress',
  name: 'In Progress',
  type: 'started',
  color: '#6b6bff',
  position: 1
}
const STATE_BACKLOG: WorkflowState = {
  id: 'linear-state-backlog',
  name: 'Backlog',
  type: 'backlog',
  color: '#999999',
  position: 0
}

function makeIssue(
  team: TeamFixture,
  workspaceName: string,
  state: WorkflowState,
  id: string,
  identifier: string,
  title: string,
  priority: number
) {
  return {
    id,
    workspaceId: team.workspaceId,
    workspaceName,
    identifier,
    title,
    url: `https://linear.example.test/${identifier}`,
    state: { name: state.name, type: state.type, color: state.color },
    team: { id: team.id, name: team.name, key: team.key },
    labels: [],
    labelIds: [],
    priority,
    updatedAt: '2026-08-04T18:00:00.000Z'
  }
}

const ISSUE_TODO = makeIssue(
  TEAM_A,
  WORKSPACE_A.organizationName,
  STATE_TODO,
  'linear-issue-todo',
  'ENG-1',
  'Alpha todo issue',
  1
)
const ISSUE_PROGRESS = makeIssue(
  TEAM_A,
  WORKSPACE_A.organizationName,
  STATE_IN_PROGRESS,
  'linear-issue-progress',
  'ENG-2',
  'Alpha progress issue',
  3
)
const ISSUE_BETA = makeIssue(
  TEAM_B,
  WORKSPACE_B.organizationName,
  STATE_BACKLOG,
  'linear-issue-beta',
  'PROD-1',
  'Beta backlog issue',
  2
)

const PROJECT = {
  id: 'linear-project-alpha',
  workspaceId: WORKSPACE_A.id,
  workspaceName: WORKSPACE_A.organizationName,
  name: 'Alpha project',
  description: 'Deliver the alpha project.',
  status: { id: 'linear-project-status', name: 'Started', type: 'started', color: '#6b6bff' },
  health: 'onTrack',
  priority: 2,
  priorityLabel: 'High',
  lead: { id: 'linear-user-ada', displayName: 'Ada Lovelace' },
  progress: 60,
  scope: 5,
  targetDate: '2026-12-31'
}

function makeCustomView(id: string, name: string, model: 'issue' | 'project', updatedAt: string) {
  return {
    id,
    workspaceId: WORKSPACE_A.id,
    workspaceName: WORKSPACE_A.organizationName,
    name,
    description: `${name} description`,
    model,
    url: `https://linear.example.test/views/${id}`,
    shared: model === 'issue',
    owner: { id: 'linear-user-ada', displayName: 'Ada Lovelace' },
    updatedAt
  }
}

const VIEW_ISSUES = makeCustomView(
  'linear-view-issues',
  'Alpha triage',
  'issue',
  '2026-08-01T00:00:00.000Z'
)
const VIEW_PROJECTS = makeCustomView(
  'linear-view-projects',
  'Alpha roadmap',
  'project',
  '2026-08-02T00:00:00.000Z'
)

const FIXTURE = {
  workspaces: [WORKSPACE_A, WORKSPACE_B],
  teams: [TEAM_A, TEAM_B],
  statesByTeamId: { [TEAM_A.id]: [STATE_TODO, STATE_IN_PROGRESS], [TEAM_B.id]: [STATE_BACKLOG] },
  issues: [ISSUE_TODO, ISSUE_PROGRESS, ISSUE_BETA],
  projects: [PROJECT],
  projectDetail: { ...PROJECT, content: 'Long-form project body.' },
  customViews: [VIEW_ISSUES, VIEW_PROJECTS]
}

// The board grid in IssueBoardColumns.tsx; its sections are the status columns.
const BOARD_SECTION_SELECTOR = 'div[class*="md:grid-cols-2"][class*="xl:grid-cols-3"] > section'

type BoardColumn = { label: string; count: number; cards: string[] }

async function installLinearBoardBackend(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, fixture) => {
    const log: BackendLog = { listIssues: [], listTeams: [], updateIssue: [] }
    Reflect.set(globalThis, '__linearBoardE2E', log)

    let selectedWorkspaceId = fixture.workspaces[0].id
    const status = () => ({
      connected: true,
      viewer: fixture.workspaces[0],
      workspaces: fixture.workspaces,
      activeWorkspaceId: selectedWorkspaceId,
      selectedWorkspaceId
    })
    const teamsFor = (workspaceId?: string) =>
      !workspaceId || workspaceId === 'all'
        ? fixture.teams
        : fixture.teams.filter((team) => team.workspaceId === workspaceId)
    const issuesFor = (workspaceId?: string) =>
      !workspaceId || workspaceId === 'all'
        ? fixture.issues
        : fixture.issues.filter((issue) => issue.workspaceId === workspaceId)
    const allStates = Object.values(fixture.statesByTeamId).flat()

    // Why: registration is uniform, and removeHandler keeps the real backend from being called.
    const handle = <A>(channel: string, listener: (args: A) => unknown): void => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (_event, args: A) => listener(args))
    }

    handle('linear:status', async () => status())
    handle('linear:selectWorkspace', async (args: { workspaceId?: string } | undefined) => {
      if (typeof args?.workspaceId === 'string' && args.workspaceId) {
        selectedWorkspaceId = args.workspaceId
      }
      return status()
    })
    handle('linear:listTeams', async (args: { workspaceId?: string } | undefined) => {
      log.listTeams.push({ workspaceId: args?.workspaceId })
      return teamsFor(args?.workspaceId ?? selectedWorkspaceId)
    })
    handle('linear:listIssues', async (args: { workspaceId?: string } | undefined) => {
      log.listIssues.push({ workspaceId: args?.workspaceId })
      return { items: issuesFor(args?.workspaceId ?? selectedWorkspaceId), hasMore: false }
    })
    handle('linear:teamStates', async (args: { teamId?: string } | undefined) => {
      const teamId = args?.teamId
      if (!teamId) {
        return []
      }
      const states: Record<string, WorkflowState[]> = fixture.statesByTeamId
      return states[teamId] ?? []
    })
    handle('linear:teamLabels', async () => [])
    handle('linear:teamMembers', async () => [])
    handle('linear:updateIssue', async (args: { id: string; updates?: { stateId?: string } }) => {
      const stateId = args?.updates?.stateId
      log.updateIssue.push({ id: args.id, stateId })
      const issue = fixture.issues.find((candidate) => candidate.id === args.id)
      const nextState = stateId ? allStates.find((state) => state.id === stateId) : undefined
      if (issue && nextState) {
        issue.state = { name: nextState.name, type: nextState.type, color: nextState.color }
      }
      return { ok: true }
    })
    handle('linear:listProjects', async () => ({ items: fixture.projects, hasMore: false }))
    handle('linear:getProject', async (args: { id: string }) =>
      args?.id === fixture.projectDetail.id ? fixture.projectDetail : null
    )
    handle('linear:listCustomViews', async (args: { model?: string } | undefined) => ({
      items: fixture.customViews.filter((view) => view.model === (args?.model ?? 'issue'))
    }))
    // Why: opening a view restores it through getCustomView; without this the selection is cleared.
    handle(
      'linear:getCustomView',
      async (args: { viewId: string } | undefined) =>
        fixture.customViews.find((view) => view.id === args?.viewId) ?? null
    )
    handle('linear:listCustomViewIssues', async (args: { viewId: string }) => {
      const view = fixture.customViews.find((candidate) => candidate.id === args?.viewId)
      return view?.model === 'issue' ? { items: issuesFor(view.workspaceId) } : { items: [] }
    })
    handle('linear:listCustomViewProjects', async (args: { viewId: string }) => {
      const view = fixture.customViews.find((candidate) => candidate.id === args?.viewId)
      return view?.model === 'project' ? { items: fixture.projects } : { items: [] }
    })
  }, FIXTURE)
}

async function readBackendLog(electronApp: ElectronApplication): Promise<BackendLog> {
  return electronApp.evaluate(() => {
    const stored: BackendLog | undefined = Reflect.get(globalThis, '__linearBoardE2E')
    return stored ?? { listIssues: [], listTeams: [], updateIssue: [] }
  })
}

async function openLinearTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettings({ uiLanguage: 'en' })
    await store.getState().checkLinearConnection(true)
    store.getState().openTaskPage({ taskSource: 'linear' })
  })
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible({
    timeout: 15_000
  })
}

async function selectLinearMode(page: Page, label: string): Promise<void> {
  await page
    .getByRole('group', { name: 'Linear task mode' })
    .getByRole('button', { name: label, exact: true })
    .click()
}

async function switchToBoard(page: Page): Promise<void> {
  const boardItem = page.getByRole('menuitemradio', { name: 'Board' })
  if ((await boardItem.count()) === 0) {
    await page.getByRole('button', { name: 'View', exact: true }).click()
  }
  await expect(boardItem).toBeVisible()
  if ((await boardItem.getAttribute('aria-checked')) !== 'true') {
    await boardItem.click({ force: true })
  }
  await expect(boardItem).toHaveCount(0)
}

async function readBoardColumns(page: Page): Promise<BoardColumn[]> {
  return page.locator(BOARD_SECTION_SELECTOR).evaluateAll((sections) =>
    sections
      .map((section) => {
        const header = section.querySelector(':scope > div:first-child')
        const spans = header ? Array.from(header.querySelectorAll('span')) : []
        return {
          label: spans[0]?.textContent?.trim() ?? '',
          count: Number(spans[1]?.textContent?.trim() ?? '0'),
          cards: Array.from(section.querySelectorAll('h3')).map(
            (heading) => heading.textContent?.trim() ?? ''
          )
        }
      })
      .filter((column) => column.label.length > 0)
  )
}

async function dragIssueCard(page: Page, sourceTitle: string, targetLabel: string): Promise<void> {
  const card = page
    .locator('div[role="button"][draggable="true"]')
    .filter({ has: page.getByRole('heading', { name: sourceTitle, exact: true }) })
  const target = page
    .locator(BOARD_SECTION_SELECTOR)
    .filter({ has: page.getByText(targetLabel, { exact: true }) })
  await card.dragTo(target)
}

async function expectColumnContains(
  page: Page,
  columnLabel: string,
  cardTitle: string
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await readBoardColumns(page))
          .find((column) => column.label === columnLabel)
          ?.cards.includes(cardTitle) ?? false,
      { timeout: 10_000 }
    )
    .toBe(true)
}

test.describe('Linear board and overview surfaces', () => {
  test.beforeEach(async ({ electronApp, orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await installLinearBoardBackend(electronApp)
    await openLinearTasks(orcaPage)
    await expect(orcaPage.getByText(ISSUE_TODO.title, { exact: true })).toBeVisible({
      timeout: 15_000
    })
  })

  test('board view groups issues into state columns', async ({ orcaPage }) => {
    await switchToBoard(orcaPage)

    await expect
      .poll(async () => (await readBoardColumns(orcaPage)).map((column) => column.label), {
        timeout: 10_000
      })
      .toEqual(expect.arrayContaining([STATE_TODO.name, STATE_IN_PROGRESS.name]))

    const columns = await readBoardColumns(orcaPage)
    expect(columns.find((column) => column.label === STATE_TODO.name)?.cards ?? []).toContain(
      ISSUE_TODO.title
    )
    expect(
      columns.find((column) => column.label === STATE_IN_PROGRESS.name)?.cards ?? []
    ).toContain(ISSUE_PROGRESS.title)
    // The Beta issue belongs to another workspace and must not leak into Alpha's board.
    expect(columns.some((column) => column.cards.includes(ISSUE_BETA.title))).toBe(false)
  })

  test('custom views list opens issue and project contents', async ({ orcaPage }) => {
    await selectLinearMode(orcaPage, 'Views')
    await expect(orcaPage.getByText(VIEW_ISSUES.name, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(orcaPage.getByText(VIEW_PROJECTS.name, { exact: true })).toBeVisible()

    await orcaPage.getByText(VIEW_ISSUES.name, { exact: true }).click()
    await expect(orcaPage.getByText(`View: ${VIEW_ISSUES.name}`, { exact: true })).toBeVisible()
    await expect(orcaPage.getByText(ISSUE_TODO.title, { exact: true })).toBeVisible()

    await orcaPage.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(orcaPage.getByText(VIEW_PROJECTS.name, { exact: true })).toBeVisible()
    await orcaPage.getByText(VIEW_PROJECTS.name, { exact: true }).click()
    await expect(orcaPage.getByText('Linear / Views', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText(PROJECT.name, { exact: true })).toBeVisible()
  })

  test('project overview renders progress, lead, and status from the stub', async ({
    orcaPage
  }) => {
    await selectLinearMode(orcaPage, 'Projects')
    await expect(orcaPage.getByText(PROJECT.name, { exact: true })).toBeVisible({ timeout: 15_000 })
    await orcaPage.getByText(PROJECT.name, { exact: true }).click()

    await expect(orcaPage.getByRole('button', { name: 'Back to projects' })).toBeVisible()
    await expect(orcaPage.getByText('Progress', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('60%', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Ada Lovelace', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Started', { exact: true })).toBeVisible()
    // Overview prefers the long-form content over the summary description when present.
    await expect(orcaPage.getByText(FIXTURE.projectDetail.content, { exact: true })).toBeVisible()
  })

  test('scope selector lists teams and switching workspace re-queries issues', async ({
    electronApp,
    orcaPage
  }) => {
    const trigger = orcaPage
      .locator('button[role="combobox"]')
      .filter({ hasText: /Alpha Workspace|All teams/ })
      .first()
    await expect(trigger).toBeVisible()
    await trigger.click()
    const popover = orcaPage.locator('[data-slot="popover-content"]')
    await expect(popover.getByText(TEAM_A.name, { exact: true })).toBeVisible()

    await popover.getByText(WORKSPACE_B.organizationName, { exact: true }).click()
    await expect(popover).toHaveCount(0)
    await expect(orcaPage.getByText(ISSUE_BETA.title, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(orcaPage.getByText(ISSUE_TODO.title, { exact: true })).toHaveCount(0)

    const log = await readBackendLog(electronApp)
    expect(log.listTeams.length).toBeGreaterThan(0)
    expect(log.listIssues.some((call) => call.workspaceId === WORKSPACE_B.id)).toBe(true)
  })

  // Product bug: the preload's native-file-drop capture handler stops drop propagation for any
  // drag that doesn't carry text/x-orca-file-path, and the board drag only sets
  // application/x-orca-linear-issue-id. React's onDrop therefore never runs and the card never
  // moves. See src/preload/preload-runtime-support.ts (installNativeFileDropHandlers) vs
  // src/renderer/src/lib/linear-board-drag-payload.ts. Remove test.fail once the drag is fixed.
  test.fail(
    'dragging a board card across columns mutates the issue state',
    async ({ electronApp, orcaPage }) => {
      await switchToBoard(orcaPage)
      await expect
        .poll(async () => (await readBoardColumns(orcaPage)).map((column) => column.label), {
          timeout: 10_000
        })
        .toEqual(expect.arrayContaining([STATE_TODO.name, STATE_IN_PROGRESS.name]))

      await dragIssueCard(orcaPage, ISSUE_TODO.title, STATE_IN_PROGRESS.name)

      await expectColumnContains(orcaPage, STATE_IN_PROGRESS.name, ISSUE_TODO.title)
      await expect
        .poll(
          async () =>
            (await readBoardColumns(orcaPage))
              .find((column) => column.label === STATE_TODO.name)
              ?.cards.includes(ISSUE_TODO.title) ?? false,
          { timeout: 10_000 }
        )
        .toBe(false)

      const log = await readBackendLog(electronApp)
      expect(log.updateIssue).toContainEqual({ id: ISSUE_TODO.id, stateId: STATE_IN_PROGRESS.id })
    }
  )
})
