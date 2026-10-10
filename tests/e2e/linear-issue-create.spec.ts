/**
 * Linear issue creation from the Tasks page. Existing Linear E2E specs cover filter chips,
 * view persistence, and URL entry — not creation. These specs mock the Linear IPC surface
 * (teams, states/labels/members, projects, list, create, get) and prove the composer,
 * team switching, project selection, submit, and empty-title validation.
 */

import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import type { LinearIssue } from '../../src/shared/linear/issue-types'
import type { LinearProjectSummary } from '../../src/shared/linear/project-types'
import type {
  LinearLabel,
  LinearMember,
  LinearTeam,
  LinearWorkflowState,
  LinearWorkspace
} from '../../src/shared/linear/workspace-types'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const WORKSPACE: LinearWorkspace = {
  id: 'linear-create-workspace',
  displayName: 'Linear Create User',
  email: 'linear-create@example.test',
  organizationId: 'linear-create-org',
  organizationName: 'Linear Create Workspace'
}

const TEAM_A: LinearTeam = {
  id: 'linear-create-team-a',
  workspaceId: WORKSPACE.id,
  name: 'Engineering',
  key: 'ENG'
}
const TEAM_B: LinearTeam = {
  id: 'linear-create-team-b',
  workspaceId: WORKSPACE.id,
  name: 'Product',
  key: 'PROD'
}

const STATE_A_TODO: LinearWorkflowState = {
  id: 'linear-create-state-a-todo',
  name: 'Todo',
  type: 'unstarted',
  color: '#888888',
  position: 0
}
const STATE_B_BACKLOG: LinearWorkflowState = {
  id: 'linear-create-state-b-backlog',
  name: 'Backlog',
  type: 'unstarted',
  color: '#666666',
  position: 0
}
const STATE_B_DONE: LinearWorkflowState = {
  id: 'linear-create-state-b-done',
  name: 'Done',
  type: 'completed',
  color: '#00aa66',
  position: 1
}

const LABEL_A: LinearLabel = { id: 'linear-create-label-a', name: 'Bug', color: '#ff0000' }
const LABEL_B: LinearLabel = { id: 'linear-create-label-b', name: 'Feature', color: '#0000ff' }
const MEMBER_A: LinearMember = { id: 'linear-create-member-a', displayName: 'Ada Lovelace' }
const MEMBER_B: LinearMember = { id: 'linear-create-member-b', displayName: 'Grace Hopper' }
const PROJECT_A: LinearProjectSummary = {
  id: 'linear-create-project-a',
  name: 'Alpha Project',
  workspaceId: WORKSPACE.id
}

const EXISTING_ISSUE: LinearIssue = {
  id: 'linear-create-existing-issue',
  workspaceId: WORKSPACE.id,
  identifier: 'ENG-100',
  title: 'Existing Linear issue',
  url: 'https://linear.example.test/ENG-100',
  state: { name: STATE_A_TODO.name, type: STATE_A_TODO.type, color: STATE_A_TODO.color },
  team: { id: TEAM_A.id, name: TEAM_A.name, key: TEAM_A.key },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: '2026-08-04T18:00:00.000Z'
}

const FIXTURE = {
  workspace: WORKSPACE,
  teams: [TEAM_A, TEAM_B],
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keyed by team id at runtime, so Record typing is required for string indexing.
  statesByTeamId: {
    [TEAM_A.id]: [STATE_A_TODO],
    [TEAM_B.id]: [STATE_B_BACKLOG, STATE_B_DONE]
  } as Record<string, LinearWorkflowState[]>,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keyed by team id at runtime, so Record typing is required for string indexing.
  labelsByTeamId: {
    [TEAM_A.id]: [LABEL_A],
    [TEAM_B.id]: [LABEL_B]
  } as Record<string, LinearLabel[]>,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keyed by team id at runtime, so Record typing is required for string indexing.
  membersByTeamId: {
    [TEAM_A.id]: [MEMBER_A],
    [TEAM_B.id]: [MEMBER_B]
  } as Record<string, LinearMember[]>,
  projects: [PROJECT_A],
  existingIssue: EXISTING_ISSUE
}

type LinearCreateCall = {
  teamId?: string
  title?: string
  description?: string
  projectId?: string | null
  stateId?: string
  assigneeId?: string | null
  priority?: number
  labelIds?: string[]
}

type LinearCreateProbe = {
  createCalls: LinearCreateCall[]
  createdIssue: LinearIssue | null
}

declare global {
  var __linearIssueCreateProbe: LinearCreateProbe | undefined
}
async function installLinearCreateBackend(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(
    ({ ipcMain }, payload) => {
      const probe: LinearCreateProbe = { createCalls: [], createdIssue: null }
      globalThis.__linearIssueCreateProbe = probe

      ipcMain.removeHandler('linear:status')
      ipcMain.handle('linear:status', async () => ({
        connected: true,
        viewer: payload.fixture.workspace,
        workspaces: [payload.fixture.workspace],
        activeWorkspaceId: payload.fixture.workspace.id,
        selectedWorkspaceId: payload.fixture.workspace.id
      }))

      ipcMain.removeHandler('linear:listTeams')
      ipcMain.handle('linear:listTeams', async () => payload.fixture.teams)

      ipcMain.removeHandler('linear:listIssues')
      ipcMain.handle('linear:listIssues', async () => ({
        items: probe.createdIssue
          ? [probe.createdIssue, payload.fixture.existingIssue]
          : [payload.fixture.existingIssue],
        hasMore: false
      }))

      ipcMain.removeHandler('linear:teamStates')
      ipcMain.handle(
        'linear:teamStates',
        async (_event, args: { teamId?: string } | undefined) =>
          (args?.teamId && payload.fixture.statesByTeamId[args.teamId]) || []
      )

      ipcMain.removeHandler('linear:teamLabels')
      ipcMain.handle(
        'linear:teamLabels',
        async (_event, args: { teamId?: string } | undefined) =>
          (args?.teamId && payload.fixture.labelsByTeamId[args.teamId]) || []
      )

      ipcMain.removeHandler('linear:teamMembers')
      ipcMain.handle(
        'linear:teamMembers',
        async (_event, args: { teamId?: string } | undefined) =>
          (args?.teamId && payload.fixture.membersByTeamId[args.teamId]) || []
      )

      ipcMain.removeHandler('linear:listProjects')
      ipcMain.handle('linear:listProjects', async () => ({
        items: payload.fixture.projects,
        hasMore: false
      }))

      ipcMain.removeHandler('linear:createIssue')
      ipcMain.handle('linear:createIssue', async (_event, args: LinearCreateCall | undefined) => {
        const call = args ?? {}
        probe.createCalls.push({ ...call })
        const team =
          payload.fixture.teams.find((candidate) => candidate.id === call.teamId) ??
          payload.fixture.teams[0]
        const states = Object.values(payload.fixture.statesByTeamId).flat()
        const state = states.find((candidate) => candidate.id === call.stateId) ?? states[0]
        const identifier = `${team.key}-9001`
        const created: LinearIssue = {
          id: 'linear-create-new-issue',
          workspaceId: payload.fixture.workspace.id,
          identifier,
          title: typeof call.title === 'string' ? call.title : '',
          description: typeof call.description === 'string' ? call.description : undefined,
          url: `https://linear.example.test/${identifier}`,
          state: { name: state.name, type: state.type, color: state.color },
          team: { id: team.id, name: team.name, key: team.key },
          labels: [],
          labelIds: [],
          priority: typeof call.priority === 'number' ? call.priority : 0,
          updatedAt: '2026-08-05T12:00:00.000Z'
        }
        probe.createdIssue = created
        return {
          ok: true,
          id: created.id,
          identifier: created.identifier,
          title: created.title,
          url: created.url
        }
      })

      ipcMain.removeHandler('linear:getIssue')
      ipcMain.handle('linear:getIssue', async () => probe.createdIssue)
    },
    { fixture: FIXTURE }
  )
}

async function readCreateProbe(electronApp: ElectronApplication): Promise<LinearCreateProbe> {
  return electronApp.evaluate(
    () => globalThis.__linearIssueCreateProbe ?? { createCalls: [], createdIssue: null }
  )
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
  await expect
    .poll(async () => getStoreState<string>(page, 'activeView'), { timeout: 10_000 })
    .toBe('tasks')
  await expect(page.getByText(EXISTING_ISSUE.title, { exact: true })).toBeVisible({
    timeout: 15_000
  })
}

async function openComposer(page: Page): Promise<Locator> {
  const newIssueButton = page.getByRole('button', { name: 'New Linear issue' })
  await expect(newIssueButton).toBeEnabled({ timeout: 15_000 })
  await newIssueButton.click()
  // Why: attribute pickers render Radix popover content that is also role="dialog", so scope to
  // the composer itself or button names shared with a menu item match two dialogs.
  const dialog = page.getByRole('dialog').filter({ hasText: 'New Issue' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function openAttributePopover(page: Page, dialog: Locator, label: string): Promise<Locator> {
  await dialog.getByRole('button', { name: label }).click()
  // Why: a just-closed Radix popover can linger while exiting, so target the visible layer only.
  const popover = page.locator('[data-slot="popover-content"]:visible').last()
  await expect(popover).toBeVisible()
  return popover
}

async function dismissPopover(page: Page): Promise<void> {
  // Why: Escape dismisses only the topmost Radix layer (the popover), leaving the dialog open.
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-slot="popover-content"]:visible')).toHaveCount(0)
}

async function openCreateComposer(electronApp: ElectronApplication, page: Page): Promise<Locator> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await installLinearCreateBackend(electronApp)
  await openLinearTasks(page)
  return openComposer(page)
}

test.describe('Linear issue create composer', () => {
  test('New issue button opens the composer with the expected fields', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openCreateComposer(electronApp, orcaPage)

    await expect(dialog.getByText('New Issue', { exact: true })).toBeVisible()
    await expect(dialog.getByPlaceholder('Issue title')).toBeVisible()
    await expect(dialog.getByPlaceholder('Add description...')).toBeVisible()
    // Two teams render the switch popover trigger showing the active team key.
    await expect(dialog.getByRole('button', { name: TEAM_A.key })).toBeVisible()
    // State picker defaults to the team's unstarted state once metadata loads.
    await expect(dialog.getByRole('button', { name: STATE_A_TODO.name })).toBeVisible({
      timeout: 10_000
    })
    await expect(dialog.getByRole('button', { name: 'Assignee' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Priority' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Project' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Labels' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create issue' })).toBeDisabled()
  })

  test('switching teams reloads states, labels, and members', async ({ electronApp, orcaPage }) => {
    const dialog = await openCreateComposer(electronApp, orcaPage)
    await expect(dialog.getByRole('button', { name: TEAM_A.key })).toBeVisible()

    // Team selector lists both teams from linear:listTeams.
    await dialog.getByRole('button', { name: TEAM_A.key }).click()
    const teamPopover = orcaPage.locator('[data-slot="popover-content"]')
    await expect(teamPopover.getByText('Switch Team', { exact: true })).toBeVisible()
    await expect(
      teamPopover.getByRole('button', { name: `${TEAM_A.key} — ${TEAM_A.name}` })
    ).toBeVisible()
    await teamPopover.getByRole('button', { name: `${TEAM_B.key} — ${TEAM_B.name}` }).click()
    // Why: the team picker stays open after a switch; close it before opening another popover layer.
    await dismissPopover(orcaPage)

    // The trigger now shows team B, and its states replaced team A's.
    await expect(dialog.getByRole('button', { name: TEAM_B.key })).toBeVisible()
    // Why: switching teams must default the state picker to the new team's state.
    await expect(dialog.getByRole('button', { name: STATE_B_BACKLOG.name })).toBeVisible({
      timeout: 10_000
    })
    await expect(dialog.getByRole('button', { name: STATE_A_TODO.name })).toHaveCount(0)

    const statesPopover = await openAttributePopover(orcaPage, dialog, STATE_B_BACKLOG.name)
    await expect(statesPopover.getByText(STATE_B_DONE.name, { exact: true })).toBeVisible()
    await dismissPopover(orcaPage)

    const membersPopover = await openAttributePopover(orcaPage, dialog, 'Assignee')
    await expect(membersPopover.getByText(MEMBER_B.displayName, { exact: true })).toBeVisible()
    await expect(membersPopover.getByText(MEMBER_A.displayName, { exact: true })).toHaveCount(0)
    await dismissPopover(orcaPage)

    const labelsPopover = await openAttributePopover(orcaPage, dialog, 'Labels')
    await expect(labelsPopover.getByText(LABEL_B.name, { exact: true })).toBeVisible()
    await expect(labelsPopover.getByText(LABEL_A.name, { exact: true })).toHaveCount(0)
    await dismissPopover(orcaPage)
  })

  test('submitting calls create and shows the new issue', async ({ electronApp, orcaPage }) => {
    const dialog = await openCreateComposer(electronApp, orcaPage)
    await dialog.getByPlaceholder('Issue title').fill('Ship the create composer')
    await dialog.getByPlaceholder('Add description...').fill('Details about the new issue')
    await dialog.getByRole('button', { name: 'Create issue' }).click()

    await expect(dialog).toHaveCount(0)

    const probe = await readCreateProbe(electronApp)
    expect(probe.createCalls).toHaveLength(1)
    expect(probe.createCalls[0]).toMatchObject({
      teamId: TEAM_A.id,
      title: 'Ship the create composer',
      description: 'Details about the new issue'
    })

    // The new issue surfaces in the detail DOM (auto-selected after creation).
    await expect(orcaPage.getByText('ENG-9001', { exact: true }).first()).toBeVisible({
      timeout: 15_000
    })
    await expect(
      orcaPage.getByText('Ship the create composer', { exact: true }).first()
    ).toBeVisible()
  })

  test('empty title keeps the dialog open and creates nothing', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openCreateComposer(electronApp, orcaPage)
    // Whitespace-only title still trims to empty.
    await dialog.getByPlaceholder('Issue title').fill('   ')
    await expect(dialog.getByRole('button', { name: 'Create issue' })).toBeDisabled()

    await dialog.getByPlaceholder('Issue title').press('Enter')
    await orcaPage.waitForTimeout(500)

    await expect(dialog).toBeVisible()
    const probe = await readCreateProbe(electronApp)
    expect(probe.createCalls).toHaveLength(0)
    expect(probe.createdIssue).toBeNull()
  })

  test('selecting a project updates the composer and the create args', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openCreateComposer(electronApp, orcaPage)
    const projectPopover = await openAttributePopover(orcaPage, dialog, 'Project')
    await expect(projectPopover.getByText('No Project', { exact: true })).toBeVisible()
    await projectPopover.getByRole('button', { name: PROJECT_A.name }).click()

    // Composer reflects the chosen project.
    await expect(dialog.getByRole('button', { name: PROJECT_A.name })).toBeVisible()

    await dialog.getByPlaceholder('Issue title').fill('Project-scoped issue')
    await dialog.getByRole('button', { name: 'Create issue' }).click()
    await expect(dialog).toHaveCount(0)

    const probe = await readCreateProbe(electronApp)
    expect(probe.createCalls).toHaveLength(1)
    expect(probe.createCalls[0]).toMatchObject({
      title: 'Project-scoped issue',
      projectId: PROJECT_A.id
    })
  })
})
