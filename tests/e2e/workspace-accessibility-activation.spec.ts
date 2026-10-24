import type { Locator } from '@stablyai/playwright-test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { seedLineageScenario } from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

async function clickWorkspaceOption(option: Locator): Promise<void> {
  await option.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('Expected an HTML workspace option')
    }
    element.click()
  })
}

test('direct option clicks activate nested workspaces and preserve modifier selection', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const { parentId, childId } = await seedLineageScenario(orcaPage)
  const parent = worktreeRow(orcaPage, parentId)
  const child = worktreeRow(orcaPage, childId)
  await expect(child).toBeVisible()

  // Homerow's captured click targets the option itself rather than its painted descendants.
  await clickWorkspaceOption(child)
  await expect(child).toHaveAttribute('aria-current', 'page')
  await expect(parent).not.toHaveAttribute('aria-current', 'page')

  const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
  await parent.evaluate((option, mac) => {
    option.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        metaKey: mac,
        ctrlKey: !mac
      })
    )
  }, isMac)
  await expect(parent).toHaveAttribute('aria-selected', 'true')
  await expect(child).toHaveAttribute('aria-current', 'page')
  await expect(parent).not.toHaveAttribute('aria-current', 'page')

  await parent.getByRole('button', { name: 'Hide 1 child workspace' }).click()
  await expect(parent.getByRole('button', { name: 'Show 1 child workspace' })).toBeVisible()
  await expect(parent).not.toHaveAttribute('aria-current', 'page')
  await parent.getByRole('button', { name: 'Show 1 child workspace' }).click()

  await clickWorkspaceOption(parent)
  await expect(parent).toHaveAttribute('aria-current', 'page')
  await child.locator('[data-worktree-title-inline-rename]').first().click()
  await expect(child).toHaveAttribute('aria-current', 'page')
  await expect(parent).not.toHaveAttribute('aria-current', 'page')
})

test('direct option clicks activate folder workspaces through the existing sidebar path', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-accessible-folder-')))
  registerPostElectronShutdownCleanup(async () =>
    rmSync(folderPath, { recursive: true, force: true })
  )
  const { gitId, folderId } = await orcaPage.evaluate(async (parentPath) => {
    const store = window.__store!
    const group = await window.api.projectGroups.create({
      name: 'Accessible folder project',
      parentPath,
      createdFrom: 'folder-scan'
    })
    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    const folder = await store
      .getState()
      .createFolderWorkspace(
        { projectGroupId: group.id, name: 'Accessible folder workspace', folderPath: parentPath },
        { runtimeEnvironmentId: null }
      )
    const git = Object.values(store.getState().worktreesByRepo).flat()[0]
    if (!folder || !git) {
      throw new Error('Expected one folder workspace and one git worktree')
    }
    store.getState().setGroupBy('workspace-status')
    store.getState().setShowActiveOnly(false)
    store.getState().setShowSleepingWorkspaces(true)
    store.setState({ collapsedGroups: new Set() })
    return { gitId: git.id, folderId: `folder:${folder.id}` }
  }, folderPath)
  const git = worktreeRow(orcaPage, gitId)
  const folder = worktreeRow(orcaPage, folderId)
  await expect(folder).toBeVisible()
  await git.locator('[data-worktree-title-inline-rename]').first().click()
  await expect(git).toHaveAttribute('aria-current', 'page')

  await clickWorkspaceOption(folder)
  await expect(folder).toHaveAttribute('aria-current', 'page')
  await expect(git).not.toHaveAttribute('aria-current', 'page')
  await clickWorkspaceOption(git)
  await expect(git).toHaveAttribute('aria-current', 'page')
  await clickWorkspaceOption(folder)
  await expect(folder).toHaveAttribute('aria-current', 'page')

  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  await orcaPage.locator('[data-worktree-sidebar]').screenshot({
    path: testInfo.outputPath('folder-accessibility-activation.png')
  })
})
