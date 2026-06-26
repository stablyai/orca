import type { ElectronApplication } from 'playwright'
import { test, expect } from './helpers/orca-app'

/**
 * Verifies the Add-Project "Devcontainer" source: with `devcontainer:list`
 * stubbed (no Docker needed), opening the source lists the devcontainers and
 * renders their client/folder info.
 */
async function stubDevcontainerList(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('devcontainer:list')
    ipcMain.handle('devcontainer:list', () => [
      {
        containerId: 'c-aprium',
        name: 'aprium-dev',
        hostFolder: '/Users/me/work/aprium',
        configFile: '/Users/me/work/aprium/.devcontainer/devcontainer.json',
        running: true,
        mounts: [{ source: '/Users/me/work/aprium', destination: '/workspaces/aprium' }]
      },
      {
        containerId: 'c-lac',
        name: 'lac-dev',
        hostFolder: '/Users/me/work/lac',
        configFile: null,
        running: false,
        mounts: [{ source: '/Users/me/work/lac', destination: '/workspaces/lac' }]
      }
    ])
  })
}

test.describe('Add project from devcontainer', () => {
  test('lists devcontainers in the Add-Project Devcontainer source', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await stubDevcontainerList(electronApp)

    await orcaPage.getByRole('button', { name: /Add Project/i }).first().click()
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
