import { mkdirSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { makeResourceManagerFixtureVisible } from './helpers/resource-manager-visible-fixture'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('Resource Manager ends a tab-less terminal this run spawned', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const folderPath = testInfo.outputPath('notes')
  mkdirSync(folderPath, { recursive: true })
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1200, height: 900 })
  const ptyId = await orcaPage.evaluate(async (folderPath) => {
    const state = window.__store!.getState()
    const group = await window.api.projectGroups.create({
      name: 'Notes',
      parentPath: folderPath,
      createdFrom: 'folder-scan'
    })
    await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    if (!group) {
      throw new Error('Could not create project group')
    }
    const folder = await state.createFolderWorkspace(
      { projectGroupId: group.id, name: 'Notes', folderPath },
      { runtimeEnvironmentId: null }
    )
    if (!folder) {
      throw new Error('Could not create folder workspace')
    }
    const spawned = await window.api.pty.spawn({
      cols: 80,
      rows: 24,
      cwd: folderPath,
      worktreeId: `folder:${folder.id}`,
      initiallyHidden: true
    })
    return spawned.id
  }, folderPath)

  await makeResourceManagerFixtureVisible(electronApp, orcaPage)
  await orcaPage.getByRole('button', { name: /^Resource Manager,/ }).click()
  await orcaPage.getByRole('tab', { name: 'PTYs', exact: true }).click()
  const panel = orcaPage.getByRole('tabpanel', { name: /^PTYs/ })
  await expect(panel.getByText(/1 without a tab/)).toBeVisible()
  await panel.getByRole('button', { name: /^End / }).click()
  const dialog = orcaPage.getByRole('dialog', { name: /^End .*\?$/ })
  await dialog.getByRole('button', { name: 'End terminal', exact: true }).click()
  // The dialog closes only after End returns, so the row state below is End's result.
  await expect(dialog).toBeHidden()
  await expect(panel.getByRole('button', { name: /^End / })).toHaveCount(0)
  await expect
    .poll(async () =>
      (await orcaPage.evaluate(() => window.api.pty.listSessions({ connectionId: null }))).map(
        (session) => session.id
      )
    )
    .not.toContain(ptyId)
})
