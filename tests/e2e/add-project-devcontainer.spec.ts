import type { ElectronApplication } from 'playwright'
import { posix } from 'node:path'
import { test, expect } from './helpers/orca-app'

/**
 * Verifies the Add-Project "Devcontainer" source: with `devcontainer:list`
 * stubbed (no Docker needed), opening the source lists the devcontainers and
 * renders their client/folder info.
 */
async function stubDevcontainerList(app: ElectronApplication): Promise<void> {
  const apriumHostFolder = posix.join('/Users', 'me', 'work', 'aprium')
  const lacHostFolder = posix.join('/Users', 'me', 'work', 'lac')
  const apriumConfigFile = posix.join(apriumHostFolder, '.devcontainer', 'devcontainer.json')
  await app.evaluate(
    (
      { ipcMain },
      paths: { apriumHostFolder: string; lacHostFolder: string; apriumConfigFile: string }
    ) => {
      ipcMain.removeHandler('devcontainer:list')
      ipcMain.handle('devcontainer:list', () => [
        {
          containerId: 'c-aprium',
          name: 'aprium-dev',
          hostFolder: paths.apriumHostFolder,
          configFile: paths.apriumConfigFile,
          running: true,
          mounts: [{ source: paths.apriumHostFolder, destination: '/workspaces/aprium' }]
        },
        {
          containerId: 'c-lac',
          name: 'lac-dev',
          hostFolder: paths.lacHostFolder,
          configFile: null,
          running: false,
          mounts: [{ source: paths.lacHostFolder, destination: '/workspaces/lac' }]
        }
      ])
    },
    { apriumHostFolder, lacHostFolder, apriumConfigFile }
  )
}

test.describe('Add project from devcontainer', () => {
  test('lists devcontainers in the Add-Project Devcontainer source', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await stubDevcontainerList(electronApp)

    await orcaPage
      .getByRole('button', { name: /Add Project/i })
      .first()
      .click()
    const addDialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
    await expect(addDialog).toBeVisible()

    await addDialog.getByRole('button', { name: /Devcontainer/i }).click()

    // The stubbed devcontainers render as selectable items.
    const items = orcaPage.getByTestId('devcontainer-item')
    await expect(items).toHaveCount(2)
    await expect(items.first()).toContainText('aprium')
    await expect(items.first()).toContainText('/Users/me/work/aprium')
    await expect(items.nth(1)).toContainText('stopped')

    await orcaPage.screenshot({
      path: testInfo.outputPath('devcontainer-source.png')
    })
    await testInfo.attach('devcontainer-source', {
      path: testInfo.outputPath('devcontainer-source.png'),
      contentType: 'image/png'
    })
  })
})
