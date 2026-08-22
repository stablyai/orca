/**
 * Linear issue list view persistence.
 *
 * Layout (list/board), grouping, ordering, and per-workspace attribute filters are
 * a per-device preference: they persist to renderer localStorage, NOT through
 * `ui.set`, so a paired host that predates the field cannot discard the resume
 * state around it. Unit tests cover serialize/sanitize; these specs prove the
 * user-visible round-trip with a mocked Linear IPC backend.
 */

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { getStoreState, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { TEST_REPO_PATH_FILE } from './global-setup'

// Mirrors src/renderer/src/components/linear-issue-view-storage.ts; hardcoded so a
// silent key rename shows up here as a failing round-trip.
const LINEAR_ISSUE_VIEW_STORAGE_KEY = 'orca.linear.issue-view.v1'

const WORKSPACE_A = {
  id: 'linear-workspace-a',
  displayName: 'Linear E2E User A',
  email: 'linear-e2e-a@example.test',
  organizationId: 'linear-org-a',
  organizationName: 'Alpha Workspace'
} as const

const WORKSPACE_B = {
  id: 'linear-workspace-b',
  displayName: 'Linear E2E User B',
  email: 'linear-e2e-b@example.test',
  organizationId: 'linear-org-b',
  organizationName: 'Beta Workspace'
} as const

const TEAM_A = {
  id: 'linear-team-a',
  name: 'Engineering',
  key: 'ENG',
  workspaceId: WORKSPACE_A.id,
  workspaceName: WORKSPACE_A.organizationName
} as const

const TEAM_B = {
  id: 'linear-team-b',
  name: 'Product',
  key: 'PROD',
  workspaceId: WORKSPACE_B.id,
  workspaceName: WORKSPACE_B.organizationName
} as const

const STATE_A = {
  id: 'linear-state-a',
  name: 'In Review',
  type: 'started',
  color: '#888888',
  position: 1
} as const

const STATE_B = {
  id: 'linear-state-b',
  name: 'Todo',
  type: 'unstarted',
  color: '#666666',
  position: 0
} as const

const ISSUE_A = {
  id: 'linear-issue-a',
  workspaceId: WORKSPACE_A.id,
  identifier: 'ENG-100',
  title: 'Persist Alpha view prefs',
  url: 'https://linear.example.test/ENG-100',
  state: { name: STATE_A.name, type: STATE_A.type, color: STATE_A.color },
  team: { id: TEAM_A.id, name: TEAM_A.name, key: TEAM_A.key },
  labels: [],
  labelIds: [],
  priority: 2,
  updatedAt: '2026-08-04T18:00:00.000Z'
} as const

const ISSUE_B = {
  id: 'linear-issue-b',
  workspaceId: WORKSPACE_B.id,
  identifier: 'PROD-200',
  title: 'Persist Beta view prefs',
  url: 'https://linear.example.test/PROD-200',
  state: { name: STATE_B.name, type: STATE_B.type, color: STATE_B.color },
  team: { id: TEAM_B.id, name: TEAM_B.name, key: TEAM_B.key },
  labels: [],
  labelIds: [],
  priority: 4,
  updatedAt: '2026-08-04T19:00:00.000Z'
} as const

type LinearIssueViewResume = {
  viewMode?: string
  groupBy?: string
  orderBy?: string
  displayProperties?: string[]
  teamPropertyTouched?: boolean
  filtersByWorkspaceId?: Record<
    string,
    {
      stateIds?: string[]
      priorities?: number[]
      assignee?: unknown
      labelIds?: string[]
    }
  >
}

const FIXTURE = {
  workspaces: [WORKSPACE_A, WORKSPACE_B],
  teams: [TEAM_A, TEAM_B],
  statesByTeamId: {
    [TEAM_A.id]: [STATE_A],
    [TEAM_B.id]: [STATE_B]
  },
  issues: [ISSUE_A, ISSUE_B]
} as const

async function installLinearPersistenceBackend(
  electronApp: ElectronApplication,
  options?: { multiWorkspace?: boolean }
): Promise<void> {
  const multiWorkspace = options?.multiWorkspace === true
  await electronApp.evaluate(
    ({ ipcMain }, payload) => {
      const workspaces = payload.multiWorkspace
        ? payload.fixture.workspaces
        : [payload.fixture.workspaces[0]]
      let activeWorkspaceId: string = workspaces[0].id

      const status = () => ({
        connected: true,
        viewer: workspaces[0],
        workspaces,
        activeWorkspaceId,
        selectedWorkspaceId: activeWorkspaceId
      })

      const teamsFor = (workspaceId: string | undefined) => {
        if (!workspaceId || workspaceId === 'all') {
          return payload.fixture.teams.filter((team) =>
            workspaces.some((workspace) => workspace.id === team.workspaceId)
          )
        }
        return payload.fixture.teams.filter((team) => team.workspaceId === workspaceId)
      }

      const issuesFor = (workspaceId: string | undefined) => {
        if (!workspaceId || workspaceId === 'all') {
          return payload.fixture.issues.filter((issue) =>
            workspaces.some((workspace) => workspace.id === issue.workspaceId)
          )
        }
        return payload.fixture.issues.filter((issue) => issue.workspaceId === workspaceId)
      }

      ipcMain.removeHandler('linear:status')
      ipcMain.handle('linear:status', async () => status())

      ipcMain.removeHandler('linear:selectWorkspace')
      ipcMain.handle(
        'linear:selectWorkspace',
        async (_event, args: { workspaceId?: string } | undefined) => {
          const next = args?.workspaceId
          if (typeof next === 'string' && next.trim()) {
            if (next === 'all' || workspaces.some((workspace) => workspace.id === next)) {
              activeWorkspaceId = next
            }
          }
          return status()
        }
      )

      ipcMain.removeHandler('linear:listTeams')
      ipcMain.handle(
        'linear:listTeams',
        async (_event, args: { workspaceId?: string } | undefined) =>
          teamsFor(args?.workspaceId ?? activeWorkspaceId)
      )

      ipcMain.removeHandler('linear:listIssues')
      ipcMain.handle(
        'linear:listIssues',
        async (_event, args: { workspaceId?: string } | undefined) => ({
          items: issuesFor(args?.workspaceId ?? activeWorkspaceId),
          hasMore: false
        })
      )

      ipcMain.removeHandler('linear:teamStates')
      ipcMain.handle('linear:teamStates', async (_event, args: { teamId?: string } | undefined) => {
        const teamId = args?.teamId
        if (!teamId) {
          return []
        }
        return (payload.fixture.statesByTeamId as Record<string, (typeof STATE_A)[]>)[teamId] ?? []
      })

      ipcMain.removeHandler('linear:teamLabels')
      ipcMain.handle('linear:teamLabels', async () => [])

      ipcMain.removeHandler('linear:teamMembers')
      ipcMain.handle('linear:teamMembers', async () => [])
    },
    { fixture: FIXTURE, multiWorkspace }
  )
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

async function closeTasksPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: store close is locale-stable; the Close tasks label is localized.
    store.getState().closeTaskPage()
  })
  await expect
    .poll(async () => getStoreState<string>(page, 'activeView'), { timeout: 5_000 })
    .not.toBe('tasks')
}

async function waitForLinearIssuesChrome(page: Page, issueTitle: string): Promise<void> {
  await expect
    .poll(async () => getStoreState<string>(page, 'activeView'), { timeout: 10_000 })
    .toBe('tasks')
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(page.getByText(issueTitle, { exact: true })).toBeVisible({ timeout: 15_000 })
}

async function openViewMenu(page: Page): Promise<void> {
  const viewButton = page.getByRole('button', { name: 'View', exact: true })
  await expect(viewButton).toBeVisible()
  if ((await page.getByRole('menuitemradio', { name: 'Board' }).count()) > 0) {
    return
  }
  await viewButton.click()
  await expect(page.getByRole('menuitemradio', { name: 'Board' })).toBeVisible()
}

async function dismissOverlayChrome(page: Page): Promise<void> {
  // Why: open Radix menus aria-hide/inert page chrome so later getByRole for
  // Filters/chips fails. Outside force-clicks on inert chrome do not close modal
  // menus in headless Electron, and the open portal covers the View trigger.
  // Esc closes the menu/popover (TaskPage leaves Esc alone while those are open).
  if (
    (await page.getByRole('menuitemradio', { name: 'Board' }).count()) > 0 ||
    (await page.locator('[data-slot="popover-content"]').count()) > 0
  ) {
    await page.keyboard.press('Escape')
  }
  await expect(page.getByRole('menuitemradio', { name: 'Board' })).toHaveCount(0)
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0)
}

async function selectViewMenuRadio(page: Page, name: string): Promise<void> {
  await openViewMenu(page)
  const item = page.getByRole('menuitemradio', { name })
  await expect(item).toBeVisible()
  // Why: Radix menus can briefly report "not stable" while the issues list reflows.
  await item.click({ force: true })
}

async function setLinearViewPreferences(
  page: Page,
  options: { viewMode: 'List' | 'Board'; groupBy: string; orderBy: string }
): Promise<void> {
  // Why: grouping/ordering first, then Board last — Board remounts the issue
  // surface and would detach an open menu if applied earlier.
  await selectViewMenuRadio(page, options.groupBy)
  await selectViewMenuRadio(page, options.orderBy)
  await selectViewMenuRadio(page, options.viewMode)
  await dismissOverlayChrome(page)

  // Toolbar List/Board toggle is md+ only; prove mode via the View menu radios.
  await openViewMenu(page)
  await expect(page.getByRole('menuitemradio', { name: options.viewMode })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(page.getByRole('menuitemradio', { name: options.groupBy })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(page.getByRole('menuitemradio', { name: options.orderBy })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await dismissOverlayChrome(page)
}

async function applyStatusFilter(page: Page, statusName: string): Promise<void> {
  await dismissOverlayChrome(page)
  const filtersButton = page.getByRole('button', { name: 'Filters', exact: true })
  await filtersButton.click()
  const popover = page.locator('[data-slot="popover-content"]')
  await popover.getByRole('button', { name: 'Status', exact: true }).click()
  await popover.getByText(statusName, { exact: true }).click()
  await filtersButton.click()
  await expect(popover).toHaveCount(0)
}

async function applyPriorityFilter(page: Page, priorityLabel: string): Promise<void> {
  const filtersButton = page.getByRole('button', { name: 'Filters', exact: true })
  await filtersButton.click()
  const popover = page.locator('[data-slot="popover-content"]')
  await popover.getByRole('button', { name: 'Priority', exact: true }).click()
  await popover.getByText(priorityLabel, { exact: true }).click()
  await filtersButton.click()
  await expect(popover).toHaveCount(0)
}

async function waitForLinearIssueViewPersisted(
  page: Page,
  predicate: (view: LinearIssueViewResume | undefined) => boolean
): Promise<void> {
  await expect
    .poll(
      async () => {
        const stored = await page.evaluate(
          (key) => window.localStorage.getItem(key),
          LINEAR_ISSUE_VIEW_STORAGE_KEY
        )
        const view = stored ? (JSON.parse(stored) as LinearIssueViewResume) : undefined
        return predicate(view) ? 'ready' : 'pending'
      },
      {
        timeout: 10_000,
        message: 'Linear issue view preferences did not persist to local storage'
      }
    )
    .toBe('ready')
}

async function expectRestoredLinearView(page: Page): Promise<void> {
  await openViewMenu(page)
  await expect(page.getByRole('menuitemradio', { name: 'Board' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(page.getByRole('menuitemradio', { name: 'Status' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(page.getByRole('menuitemradio', { name: 'Updated' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await dismissOverlayChrome(page)
  // Board surface renders status sections; flat list shows a Key column header.
  await expect(page.getByText('Key', { exact: true })).toHaveCount(0)
}

async function switchLinearWorkspace(page: Page, organizationName: string): Promise<void> {
  // Why: multi-workspace trigger label is "Org / All teams".
  const trigger = page
    .locator('button[role="combobox"]')
    .filter({ hasText: /All teams|Alpha|Beta|All workspaces/ })
    .first()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await trigger.click()
  const popover = page.locator('[data-slot="popover-content"]')
  await popover.getByText(organizationName, { exact: true }).click()
  await expect(popover).toHaveCount(0)
}

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

test.describe('Linear issue view persistence', () => {
  test('preserves view mode, grouping, ordering, and filters across a tasks remount', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await installLinearPersistenceBackend(electronApp)
    await openLinearTasks(orcaPage)
    await waitForLinearIssuesChrome(orcaPage, ISSUE_A.title)

    await setLinearViewPreferences(orcaPage, {
      viewMode: 'Board',
      groupBy: 'Status',
      orderBy: 'Updated'
    })
    await applyStatusFilter(orcaPage, STATE_A.name)

    await waitForLinearIssueViewPersisted(orcaPage, (view) => {
      if (
        !view ||
        view.viewMode !== 'board' ||
        view.groupBy !== 'status' ||
        view.orderBy !== 'updated'
      ) {
        return false
      }
      const filter = view.filtersByWorkspaceId?.[WORKSPACE_A.id]
      return Boolean(filter?.stateIds?.includes(STATE_A.id))
    })

    // User-visible before remount.
    await expectRestoredLinearView(orcaPage)
    const statusChip = orcaPage.getByRole('button', { name: 'Remove Status filter' }).locator('..')
    await expect(statusChip).toContainText(STATE_A.name)

    await closeTasksPage(orcaPage)
    await openLinearTasks(orcaPage)
    await waitForLinearIssuesChrome(orcaPage, ISSUE_A.title)

    await expectRestoredLinearView(orcaPage)
    await expect(
      orcaPage.getByRole('button', { name: 'Remove Status filter' }).locator('..')
    ).toContainText(STATE_A.name)
    // Board surface, not the flat list column header.
    await expect(orcaPage.getByText(STATE_A.name, { exact: true }).first()).toBeVisible()
  })

  test('keeps attribute filters scoped per Linear workspace', async ({ electronApp, orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await installLinearPersistenceBackend(electronApp, { multiWorkspace: true })
    await openLinearTasks(orcaPage)
    await waitForLinearIssuesChrome(orcaPage, ISSUE_A.title)

    await applyPriorityFilter(orcaPage, 'High')
    await expect(
      orcaPage.getByRole('button', { name: 'Remove Priority filter' }).locator('..')
    ).toContainText('High')

    await waitForLinearIssueViewPersisted(orcaPage, (view) => {
      const filter = view?.filtersByWorkspaceId?.[WORKSPACE_A.id]
      return Boolean(filter?.priorities?.includes(2))
    })

    await switchLinearWorkspace(orcaPage, WORKSPACE_B.organizationName)
    await waitForLinearIssuesChrome(orcaPage, ISSUE_B.title)
    // Workspace B starts unfiltered — Alpha's High must not leak.
    await expect(orcaPage.getByRole('button', { name: 'Remove Priority filter' })).toHaveCount(0)

    await applyPriorityFilter(orcaPage, 'Low')
    await expect(
      orcaPage.getByRole('button', { name: 'Remove Priority filter' }).locator('..')
    ).toContainText('Low')

    await waitForLinearIssueViewPersisted(orcaPage, (view) => {
      const a = view?.filtersByWorkspaceId?.[WORKSPACE_A.id]
      const b = view?.filtersByWorkspaceId?.[WORKSPACE_B.id]
      return Boolean(a?.priorities?.includes(2) && b?.priorities?.includes(4))
    })

    await switchLinearWorkspace(orcaPage, WORKSPACE_A.organizationName)
    await waitForLinearIssuesChrome(orcaPage, ISSUE_A.title)
    await expect(
      orcaPage.getByRole('button', { name: 'Remove Priority filter' }).locator('..')
    ).toContainText('High')
    await expect(
      orcaPage.getByRole('button', { name: 'Remove Priority filter' }).locator('..')
    ).not.toContainText('Low')

    await switchLinearWorkspace(orcaPage, WORKSPACE_B.organizationName)
    await waitForLinearIssuesChrome(orcaPage, ISSUE_B.title)
    await expect(
      orcaPage.getByRole('button', { name: 'Remove Priority filter' }).locator('..')
    ).toContainText('Low')
  })
})

test('restores Linear view preferences after an app restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright fixture opt-out
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    await waitForSessionReady(first.page)
    await attachRepoAndOpenTerminal(first.page, repoPath)

    await installLinearPersistenceBackend(firstApp)
    await openLinearTasks(first.page)
    await waitForLinearIssuesChrome(first.page, ISSUE_A.title)

    await setLinearViewPreferences(first.page, {
      viewMode: 'Board',
      groupBy: 'Status',
      orderBy: 'Updated'
    })
    await applyStatusFilter(first.page, STATE_A.name)
    await waitForLinearIssueViewPersisted(first.page, (view) => {
      if (
        !view ||
        view.viewMode !== 'board' ||
        view.groupBy !== 'status' ||
        view.orderBy !== 'updated'
      ) {
        return false
      }
      return Boolean(view.filtersByWorkspaceId?.[WORKSPACE_A.id]?.stateIds?.includes(STATE_A.id))
    })
    await expectRestoredLinearView(first.page)

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    // Why: IPC mocks die with the process; reinstall before reopening Linear.
    await installLinearPersistenceBackend(secondApp)
    await openLinearTasks(second.page)
    await waitForLinearIssuesChrome(second.page, ISSUE_A.title)

    await expectRestoredLinearView(second.page)
    await expect(
      second.page.getByRole('button', { name: 'Remove Status filter' }).locator('..')
    ).toContainText(STATE_A.name)
  } finally {
    for (const app of [secondApp, firstApp]) {
      if (!app) {
        continue
      }
      try {
        await session.close(app)
      } catch {
        // best-effort cleanup
      }
    }
    await session.dispose()
  }
})
