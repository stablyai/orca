import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { expectSidebarProjectVisible } from './helpers/sidebar-project-visibility'
import { startHiddenRendererFrameCapture } from './helpers/hidden-renderer-frame-capture'

test('an incognito project hides until unlocked with the passcode', async ({
  orcaPage,
  electronApp,
  seededRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const browserWindow = await electronApp.browserWindow(orcaPage)
  await browserWindow.evaluate((window) => window.webContents.setBackgroundThrottling(false))
  await browserWindow.dispose()
  const stopCapture = await startHiddenRendererFrameCapture(orcaPage)
  try {
    await runIncognitoJourney(orcaPage, seededRepoPath, testInfo)
  } finally {
    await stopCapture()
  }
})

async function runIncognitoJourney(
  orcaPage: Page,
  seededRepoPath: string,
  testInfo: TestInfo
): Promise<void> {
  const projectName = await orcaPage.evaluate(async (repoPath) => {
    const store = window.__store!
    store.getState().setGroupBy('repo')
    const repo = store.getState().repos.find((candidate) => candidate.path === repoPath)
    if (!repo) {
      throw new Error('Seeded repo missing from the store')
    }
    // No Touch ID or passcode yet on this profile, so this opens the setup dialog.
    void store.getState().setProjectIncognito(repo, true)
    return repo.displayName
  }, seededRepoPath)

  const sidebar = orcaPage.getByRole('listbox', { name: 'Worktrees', exact: true })
  await expectSidebarProjectVisible(orcaPage, projectName)

  const setup = orcaPage.getByRole('dialog', { name: 'Set an incognito passcode' })
  await expect(setup).toBeVisible()
  await setup.getByLabel('Passcode', { exact: true }).fill('orca-e2e')
  await setup.getByLabel('Confirm passcode').fill('orca-e2e')
  await orcaPage.screenshot({
    path: testInfo.outputPath('1-setup-dialog.png'),
    animations: 'disabled'
  })
  await setup.getByRole('button', { name: 'Set passcode' }).click()
  await expect(setup).toBeHidden()

  await expect(orcaPage.getByText('Project hidden in incognito')).toBeVisible()
  await expect(sidebar.getByText(projectName, { exact: false })).toHaveCount(0)
  // The open workspace must leave the screen too, not only its sidebar row.
  await expect(
    orcaPage.getByText(projectName, { exact: false }).filter({ visible: true })
  ).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('2-project-hidden.png') })

  await orcaPage.getByRole('button', { name: /^Workspace options/ }).click()
  await orcaPage.getByRole('switch', { name: /Show incognito projects/ }).click()
  const unlock = orcaPage.getByRole('dialog', { name: 'Show incognito projects' })
  await expect(unlock).toBeVisible()
  await unlock.getByLabel('Passcode', { exact: true }).fill('wrong-code')
  await unlock.getByRole('button', { name: 'Unlock' }).click()
  await expect(unlock.getByText('That passcode is not correct.')).toBeVisible()
  await expect(sidebar.getByText(projectName, { exact: false })).toHaveCount(0)

  await unlock.getByLabel('Passcode', { exact: true }).fill('orca-e2e')
  await unlock.getByRole('button', { name: 'Unlock' }).click()
  await expect(unlock).toBeHidden()
  await expectSidebarProjectVisible(orcaPage, projectName)
  await expect(
    sidebar.getByLabel('Incognito project — hidden when incognito projects are locked')
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('3-project-unlocked.png') })

  await orcaPage.getByRole('button', { name: /^Workspace options/ }).click()
  await orcaPage.getByRole('switch', { name: /Show incognito projects/ }).click()
  await expect(sidebar.getByText(projectName, { exact: false })).toHaveCount(0)
}
