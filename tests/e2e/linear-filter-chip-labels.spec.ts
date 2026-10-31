import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE = {
  workspace: {
    id: 'linear-workspace-3393',
    displayName: 'Linear E2E User',
    email: 'linear-e2e@example.test',
    organizationId: 'linear-org-3393',
    organizationName: 'Linear E2E Workspace'
  },
  team: {
    id: 'linear-team-3393',
    name: 'Engineering',
    key: 'ENG'
  },
  state: {
    id: 'linear-state-uuid-3393',
    name: 'In Review',
    type: 'started',
    color: '#888888',
    position: 1
  },
  issue: {
    id: 'linear-issue-3393',
    workspaceId: 'linear-workspace-3393',
    identifier: 'ENG-3393',
    title: 'Keep filter chip labels readable',
    url: 'https://linear.example.test/ENG-3393',
    state: { name: 'In Review', type: 'started', color: '#888888' },
    team: { id: 'linear-team-3393', name: 'Engineering', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-08-04T18:00:00.000Z'
  }
} as const

async function installLinearFilterBackend(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, fixture) => {
    ipcMain.removeHandler('linear:status')
    ipcMain.handle('linear:status', async () => ({
      connected: true,
      viewer: fixture.workspace,
      workspaces: [fixture.workspace],
      activeWorkspaceId: fixture.workspace.id,
      selectedWorkspaceId: fixture.workspace.id
    }))

    ipcMain.removeHandler('linear:listTeams')
    ipcMain.handle('linear:listTeams', async () => [fixture.team])

    ipcMain.removeHandler('linear:listIssues')
    ipcMain.handle('linear:listIssues', async () => ({ items: [fixture.issue], hasMore: false }))

    ipcMain.removeHandler('linear:teamStates')
    ipcMain.handle('linear:teamStates', async () => [fixture.state])

    ipcMain.removeHandler('linear:teamLabels')
    ipcMain.handle('linear:teamLabels', async () => [])

    ipcMain.removeHandler('linear:teamMembers')
    ipcMain.handle('linear:teamMembers', async () => [])
  }, FIXTURE)
}

async function openLinearTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().checkLinearConnection(true)
    store.getState().openTaskPage({ taskSource: 'linear' })
  })
}

test('Linear filter chips keep readable names after the dropdown closes', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await installLinearFilterBackend(electronApp)
  await openLinearTasks(orcaPage)

  await expect
    .poll(() => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
    .toBe('tasks')
  const filtersButton = orcaPage.getByRole('button', { name: 'Filters', exact: true })
  await expect(filtersButton).toBeVisible()
  await expect(orcaPage.getByText(FIXTURE.issue.title, { exact: true })).toBeVisible()

  await filtersButton.click()
  const popover = orcaPage.locator('[data-slot="popover-content"]')
  await popover.getByRole('button', { name: 'Status', exact: true }).click()
  await popover.getByText(FIXTURE.state.name, { exact: true }).click()
  await filtersButton.click()
  await expect(popover).toHaveCount(0)

  const statusChip = orcaPage.getByRole('button', { name: 'Remove Status filter' }).locator('..')
  await expect(statusChip).toContainText(FIXTURE.state.name)
  await expect(statusChip).not.toContainText(FIXTURE.state.id)
})
