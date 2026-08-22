import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const LOCAL_PROJECT = 'E2E Palette Local Project'
const REMOTE_PROJECT = 'E2E Palette Remote Project'
const REMOTE_WORKSPACE = 'E2E Palette Remote Workspace'
const REMOTE_HOST = 'E2E Palette Builder'
const SEARCH_PLACEHOLDER = 'Search chats, terminals, worktrees, settings, and actions...'

type PaletteFilterFixture = { localWorktreeId: string; remoteWorktreeId: string }

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
      const remoteRepo = {
        ...sourceRepo,
        id: remoteRepoId,
        path: `${sourceRepo.path}-e2e-palette-remote-${token}`,
        displayName: remoteProject,
        connectionId: remoteConnectionId,
        executionHostId: `ssh:${remoteConnectionId}`
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
        hostId: `ssh:${remoteConnectionId}`
      }

      const sshTargetLabels = new Map(state.sshTargetLabels)
      sshTargetLabels.set(remoteConnectionId, remoteHost)
      // Filter options use project.displayName when a Project entity exists;
      // renaming only the repo leaves the option labeled with the path basename.
      const projects = state.projects.map((project) =>
        project.sourceRepoIds.includes(sourceRepo.id)
          ? { ...project, displayName: localProject }
          : project
      )
      store.setState({
        repos: [
          ...state.repos.map((repo) =>
            repo.id === sourceRepo.id ? { ...repo, displayName: localProject } : repo
          ),
          remoteRepo
        ],
        projects,
        sshTargetLabels,
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [sourceRepo.id]: (state.worktreesByRepo[sourceRepo.id] ?? []).map((worktree) =>
            worktree.id === sourceWorktree.id ? { ...worktree, hostId: 'local' } : worktree
          ),
          [remoteRepoId]: [remoteWorktree]
        }
      })

      return { localWorktreeId: sourceWorktree.id, remoteWorktreeId }
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

test.describe('Worktree jump-palette filters', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('filters workspace results by host, intersects project selection, and resets on close', async ({
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

    // P2: host and project fields intersect, with the filter-specific empty state.
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

    // P3: clear restores both rows; closing drops the ephemeral filter.
    await filterTrigger(orcaPage).click()
    await palette(orcaPage).getByRole('button', { name: 'Clear all' }).last().click()
    await filterTrigger(orcaPage).click()
    await expect(filterTrigger(orcaPage)).not.toContainText('1')
    await searchFixtureWorkspaces(orcaPage, fixture)

    await selectRemoteHost(orcaPage)
    await orcaPage.evaluate(() => window.__store?.getState().closeModal())
    await expect(palette(orcaPage)).toBeHidden()
    await openPalette(orcaPage)
    await searchFixtureWorkspaces(orcaPage, fixture)
    await expect(filterTrigger(orcaPage)).not.toContainText('1')
  })

  test('pressing Enter creates a worktree from a typed name', async ({ orcaPage }) => {
    await openPalette(orcaPage)
    const input = palette(orcaPage).getByPlaceholder(SEARCH_PLACEHOLDER)
    await input.fill(`cmd-j-enter-${Date.now()}`)
    await expect(
      palette(orcaPage).locator('[cmdk-item][data-value="__create_worktree__"]')
    ).toBeVisible()

    await input.press('Enter')

    const createDialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await expect(createDialog).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(createDialog).toBeHidden()
  })
})
