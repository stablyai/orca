import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'

test.use({ seedTestRepo: false })

for (const theme of ['dark', 'light'] as const) {
  test(`Resource Manager names folder workspaces and their groups (${theme})`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-resource-folders-'))
    registerPostElectronShutdownCleanup(async () => rmSync(root, { recursive: true, force: true }))
    const folders = ['Release notes', 'Customer research'].map((name) => {
      const folderPath = join(root, name)
      mkdirSync(folderPath)
      return { name, folderPath }
    })
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 900 })
    await orcaPage.evaluate(
      async ({ theme, folders }) => {
        const state = window.__store!.getState()
        await state.updateSettingsOrThrow({ theme })
        for (const [index, folder] of folders.entries()) {
          const group = await window.api.projectGroups.create({
            name: index === 0 ? 'Documentation' : 'Product',
            parentPath: folder.folderPath,
            createdFrom: 'folder-scan'
          })
          await state.fetchProjectGroups()
          if (!group) {
            throw new Error('Could not create project group')
          }
          const workspace = await state.createFolderWorkspace({
            projectGroupId: group.id,
            ...folder
          })
          if (!workspace) {
            throw new Error('Could not create folder workspace')
          }
          await window.api.pty.spawn({
            cols: 80,
            rows: 24,
            cwd: workspace.folderPath,
            worktreeId: `folder:${workspace.id}`,
            initiallyHidden: true
          })
        }
        await window.__store!.getState().fetchMemorySnapshot()
      },
      { theme, folders }
    )

    await orcaPage.getByRole('button', { name: /^Resource Manager,/ }).click()
    const popover = orcaPage.getByRole('dialog')
    await expect(popover.getByText('Resource Manager', { exact: true })).toBeVisible()
    await expect(popover.getByRole('button', { name: /^Resume workspace/ })).toHaveCount(2)
    const screenshot = testInfo.outputPath(`resource-manager-folders-${theme}.png`)
    await orcaPage.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach(`resource-manager-folders-${theme}`, {
      path: screenshot,
      contentType: 'image/png'
    })

    await expect(popover.getByText('Documentation', { exact: true })).toBeVisible()
    await expect(popover.getByText('Product', { exact: true })).toBeVisible()
    for (const { name } of folders) {
      await expect(
        popover.getByRole('button', { name: `Resume workspace ${name}`, exact: true })
      ).toBeVisible()
    }
    await expect(popover).not.toContainText('folder:')
  })
}

test('names a folder terminal recovered from the daemon after restart without an open tab', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-recovered-folder-'))
  const session = createRestartSession(testInfo)
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    await launched.page.evaluate(async (folderPath) => {
      const state = window.__store!.getState()
      await state.updateSettingsOrThrow({ theme: 'dark' })
      const group = await window.api.projectGroups.create({
        name: 'Documentation',
        parentPath: folderPath,
        createdFrom: 'folder-scan'
      })
      await state.fetchProjectGroups()
      if (!group) {
        throw new Error('Could not create project group')
      }
      const folder = await state.createFolderWorkspace({
        projectGroupId: group.id,
        name: 'Recovered notes',
        folderPath
      })
      if (!folder) {
        throw new Error('Could not create folder workspace')
      }
      await window.api.pty.spawn({
        cols: 80,
        rows: 24,
        cwd: folderPath,
        worktreeId: `folder:${folder.id}`,
        initiallyHidden: true
      })
    }, root)
    await session.close(launched.app)
    launched = await session.launch()
    const page = launched.page
    await waitForSessionReady(page)
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.evaluate(() => window.__store!.getState().fetchMemorySnapshot())
    await page.getByRole('button', { name: /^Resource Manager,/ }).click()
    const popover = page.getByRole('dialog')
    await expect(popover.getByText('Resource Manager', { exact: true })).toBeVisible()
    try {
      await expect(
        popover.getByRole('button', { name: 'Resume workspace Recovered notes', exact: true })
      ).toBeVisible()
      await expect(popover.getByText(/^pid \d+$/)).toBeVisible()
      await expect(popover).not.toContainText('Unattributed')
      await expect(popover).not.toContainText('folder:')
    } finally {
      const screenshot = testInfo.outputPath('resource-manager-recovered-folder.png')
      await page.screenshot({ path: screenshot, animations: 'disabled' })
      await testInfo.attach('resource-manager-recovered-folder', {
        path: screenshot,
        contentType: 'image/png'
      })
    }
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
