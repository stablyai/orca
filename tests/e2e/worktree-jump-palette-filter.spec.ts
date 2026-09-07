import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const LOCAL_PROJECT = 'E2E Palette Local Project'
const REMOTE_PROJECT = 'E2E Palette Remote Project'
const REMOTE_WORKSPACE = 'E2E Palette Remote Workspace'
const REMOTE_HOST = 'E2E Palette Builder'
const SEARCH_PLACEHOLDER = 'Search chats, terminals, worktrees, settings, and actions...'

type PaletteFilterFixture = {
  localRepoId: string
  localWorktreeId: string
  remoteWorktreeId: string
}

async function seedPaletteFilterFixture(page: Page): Promise<PaletteFilterFixture> {
  return page.evaluate(
    ({ localProject, remoteHost, remoteProject, remoteWorkspace }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }

      const state = store.getState()
      const sourceRepo = state.repos[0]
      const sourceWorktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.repoId === sourceRepo?.id && !worktree.isArchived)
      if (!sourceRepo || !sourceWorktree) {
        throw new Error('Palette filter E2E needs the seeded local repository')
      }

      const token = crypto.randomUUID()
      const remoteConnectionId = `e2e-palette-host-${token}`
      const remoteRepoId = `e2e-palette-remote-repo-${token}`
      const remoteWorktreeId = `e2e-palette-remote-worktree-${token}`
      const remoteHostId = `ssh:${remoteConnectionId}` as const
      const remoteRepo = {
        ...sourceRepo,
        id: remoteRepoId,
        path: `${sourceRepo.path}-e2e-palette-remote-${token}`,
        displayName: remoteProject,
        connectionId: remoteConnectionId,
        executionHostId: remoteHostId
      }
      const remoteWorktree = {
        ...sourceWorktree,
        id: remoteWorktreeId,
        repoId: remoteRepoId,
        path: `${sourceWorktree.path}-e2e-palette-remote-${token}`,
        displayName: remoteWorkspace,
        title: remoteWorkspace,
        branch: 'refs/heads/e2e-palette-remote',
        isMainWorktree: false,
        isArchived: false,
        hostId: remoteHostId
      }

      const sshTargetLabels = new Map(state.sshTargetLabels)
      sshTargetLabels.set(remoteConnectionId, remoteHost)
      store.setState({
        repos: [
          ...state.repos.map((repo) =>
            repo.id === sourceRepo.id ? { ...repo, displayName: localProject } : repo
          ),
          remoteRepo
        ],
        sshTargetLabels,
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [sourceRepo.id]: (state.worktreesByRepo[sourceRepo.id] ?? []).map((worktree) =>
            worktree.id === sourceWorktree.id ? { ...worktree, hostId: 'local' } : worktree
          ),
          [remoteRepoId]: [remoteWorktree]
        }
      })

      return {
        localRepoId: sourceRepo.id,
        localWorktreeId: sourceWorktree.id,
        remoteWorktreeId
      }
    },
    {
      localProject: LOCAL_PROJECT,
      remoteHost: REMOTE_HOST,
      remoteProject: REMOTE_PROJECT,
      remoteWorkspace: REMOTE_WORKSPACE
    }
  )
}

function worktreeRow(page: Page, worktreeId: string) {
  return palette(page).locator(`[cmdk-item][data-value="worktree:${worktreeId}"]`)
}

function palette(page: Page) {
  return page.getByRole('dialog', { name: 'Jump to...' })
}

function filterTrigger(page: Page) {
  return page.getByRole('button', { name: 'Filter results' })
}

async function openPalette(page: Page): Promise<void> {
  await page.evaluate(() => window.__store?.getState().openModal('worktree-palette'))
  await expect(palette(page)).toBeVisible()
}

async function searchFixtureWorkspaces(page: Page, fixture: PaletteFilterFixture): Promise<void> {
  const input = palette(page).getByPlaceholder(SEARCH_PLACEHOLDER)
  await input.fill('E2E Palette')
  await expect(worktreeRow(page, fixture.localWorktreeId)).toBeVisible()
  await expect(worktreeRow(page, fixture.remoteWorktreeId)).toBeVisible()
}

async function selectRemoteHost(page: Page, useKeyboard = false): Promise<void> {
  if (useKeyboard) {
    const input = palette(page).getByPlaceholder(SEARCH_PLACEHOLDER)
    await input.press('Tab')
    await expect(filterTrigger(page)).toBeFocused()
    await filterTrigger(page).click()
  } else {
    await filterTrigger(page).click()
  }

  await expect(palette(page).getByText('Hosts', { exact: true })).toBeVisible()
  await palette(page).getByText('Hosts', { exact: true }).click()
  const hosts = palette(page).getByRole('listbox', { name: 'Hosts' })
  await expect(hosts.getByRole('option', { name: REMOTE_HOST })).toBeVisible()
  await hosts.getByRole('option', { name: REMOTE_HOST }).click()
  await filterTrigger(page).click()
}

async function openComposerFromTypedName(page: Page): Promise<Locator> {
  await openPalette(page)
  const input = palette(page).getByPlaceholder(SEARCH_PLACEHOLDER)
  await input.fill(`cmd-j-enter-${Date.now()}`)
  await expect(palette(page).locator('[cmdk-item][data-value="__create_worktree__"]')).toBeVisible()

  await input.press('Enter')

  const createDialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(createDialog).toBeVisible()
  // Why assert focus: the composer auto-focuses the name field, so Escape always
  // lands on an input the user never chose. A page-style "blur the field first"
  // handler reachable from here would silently cost a second press.
  await expect(createDialog.locator('[data-workspace-name-input="true"]')).toBeFocused()
  return createDialog
}

test.describe('Worktree jump-palette filters', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })
  test.afterEach(async ({ orcaPage }) => {
    await orcaPage.evaluate(() => {
      const store = window.__store?.getState()
      store?.setFilterRepoIds([])
      store?.closeModal()
    })
  })

  test('filters results, intersects fields, and reseeds from the sidebar on reopen', async ({
    orcaPage
  }) => {
    const fixture = await seedPaletteFilterFixture(orcaPage)
    await openPalette(orcaPage)
    await searchFixtureWorkspaces(orcaPage, fixture)

    // P1: keyboard focus reaches the control; its rendered selection narrows rows.
    await selectRemoteHost(orcaPage, true)
    await expect(filterTrigger(orcaPage)).toContainText('1')
    await expect(palette(orcaPage).getByLabel(`Remove filter ${REMOTE_HOST}`)).toBeVisible()
    await expect(worktreeRow(orcaPage, fixture.remoteWorktreeId)).toBeVisible()
    await expect(worktreeRow(orcaPage, fixture.localWorktreeId)).toHaveCount(0)

    // P2: host and repository fields intersect, with the filter-specific empty state.
    await palette(orcaPage).getByPlaceholder(SEARCH_PLACEHOLDER).fill('')
    await filterTrigger(orcaPage).click()
    await palette(orcaPage).getByText('Projects', { exact: true }).click()
    const projects = palette(orcaPage).getByRole('listbox', { name: 'Projects' })
    const localProject = projects.getByRole('option', { name: LOCAL_PROJECT })
    await expect(localProject).toBeVisible()
    await localProject.click()
    await filterTrigger(orcaPage).click()
    await expect(palette(orcaPage).getByText('No results match the active filter')).toBeVisible()
    await expect(
      palette(orcaPage).getByText('Clear the filter above, or widen it to more hosts and projects.')
    ).toBeVisible()

    // P3: clear restores both rows; reopening replaces ephemeral state with the sidebar scope.
    await filterTrigger(orcaPage).click()
    await palette(orcaPage).getByRole('button', { name: 'Clear all' }).last().click()
    await filterTrigger(orcaPage).click()
    await expect(filterTrigger(orcaPage)).not.toContainText('1')
    await searchFixtureWorkspaces(orcaPage, fixture)

    await selectRemoteHost(orcaPage)
    await orcaPage.evaluate((repoId) => {
      const store = window.__store?.getState()
      store?.closeModal()
      store?.setFilterRepoIds([repoId])
    }, fixture.localRepoId)
    await expect(palette(orcaPage)).toBeHidden()
    await openPalette(orcaPage)
    await palette(orcaPage).getByPlaceholder(SEARCH_PLACEHOLDER).fill('E2E Palette')
    await expect(filterTrigger(orcaPage)).toContainText('1')
    await expect(worktreeRow(orcaPage, fixture.localWorktreeId)).toBeVisible()
    await expect(worktreeRow(orcaPage, fixture.remoteWorktreeId)).toHaveCount(0)
  })

  test('opens with the sidebar repository scope without widening it', async ({ orcaPage }) => {
    const fixture = await seedPaletteFilterFixture(orcaPage)
    await orcaPage.evaluate((repoId) => {
      window.__store?.getState().setFilterRepoIds([repoId])
    }, fixture.localRepoId)

    await openPalette(orcaPage)
    await palette(orcaPage).getByPlaceholder(SEARCH_PLACEHOLDER).fill('E2E Palette')

    await expect(filterTrigger(orcaPage)).toContainText('1')
    await expect(palette(orcaPage).getByLabel(`Remove filter ${LOCAL_PROJECT}`)).toBeVisible()
    await expect(worktreeRow(orcaPage, fixture.localWorktreeId)).toBeVisible()
    await expect(worktreeRow(orcaPage, fixture.remoteWorktreeId)).toHaveCount(0)
  })

  test('pressing Enter creates a worktree from a typed name', async ({ orcaPage }) => {
    const createDialog = await openComposerFromTypedName(orcaPage)

    await orcaPage.keyboard.press('Escape')

    await expect(createDialog).toBeHidden()
  })

  test('Escape closes the composer opened over the Automations page', async ({ orcaPage }) => {
    // Why this view: Cmd+J has no view guard, and a page mounted under the palette
    // keeps its own capture-phase Escape listener registered. Window capture runs
    // before Radix's document capture, so a preventDefault there vetoes dismissal.
    await orcaPage.evaluate(() => window.__store?.getState().openAutomationsPage())
    const automationsHeading = orcaPage.getByRole('heading', { name: 'Automations', level: 1 })
    await expect(automationsHeading).toBeVisible()

    const createDialog = await openComposerFromTypedName(orcaPage)

    await orcaPage.keyboard.press('Escape')

    await expect(createDialog).toBeHidden()
    // The page declined the press rather than consuming it, so it is still open.
    await expect(automationsHeading).toBeVisible()
  })
})
