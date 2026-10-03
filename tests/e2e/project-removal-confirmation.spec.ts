import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ minimumSeededWorktreeCount: 1 })

test('project removal preference can be cancelled, saved, and restored', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  const project = await orcaPage.evaluate(() => {
    const repo = window.__store!.getState().repos[0]
    return { name: repo.displayName, path: repo.path }
  })
  const actions = orcaPage.getByRole('button', {
    name: `Project actions for ${project.name}`,
    exact: true
  })
  const header = orcaPage.locator('[data-repo-header-id]').filter({ has: actions })
  const dialog = orcaPage.getByRole('dialog', { name: 'Remove Project', exact: true })
  const openRemoval = async (): Promise<void> => {
    await header.hover()
    await actions.click()
    await orcaPage.getByRole('menuitem', { name: 'Remove Project', exact: true }).click()
  }

  await openRemoval()
  await expect(dialog.getByRole('checkbox', { name: "Don't ask again" })).not.toBeChecked()
  await dialog.getByRole('checkbox').check()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('project-removal-confirmation.png')
  })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(header).toBeVisible()

  await openRemoval()
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(header).toBeHidden()
  await expect(
    orcaPage.getByText("We'll skip this confirmation next time.", { exact: true })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Open Settings', exact: true }).click()
  const setting = orcaPage.getByRole('switch', {
    name: 'Ask Before Removing Projects',
    exact: true
  })
  await expect(setting).not.toBeChecked()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('project-removal-settings.png')
  })

  await orcaPage.evaluate(async (repoPath) => {
    const state = window.__store!.getState()
    state.closeSettingsPage()
    await state.addRepoPath(repoPath)
  }, project.path)
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await expect(header).toBeVisible()
  await openRemoval()
  await expect(header).toBeHidden()
  await expect(dialog).toBeHidden()

  await orcaPage.evaluate(async (repoPath) => {
    const state = window.__store!.getState()
    await state.addRepoPath(repoPath)
    state.openSettingsPage()
    state.openSettingsTarget({
      pane: 'general',
      repoId: null,
      sectionId: 'general-skip-remove-project-confirm'
    })
  }, project.path)
  await expect(setting).not.toBeChecked()
  await setting.click()
  await expect(setting).toBeChecked()
  await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
  await openRemoval()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('checkbox').check()
  await orcaPage.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await openRemoval()
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await orcaPage.keyboard.press('Escape')
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({ uiLanguage: 'ko', theme: 'dark' })
  )
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const repo = state.repos[0]
    state.openModal('confirm-remove-folder', {
      repoId: repo.id,
      displayName: repo.displayName,
      hostId: 'local'
    })
  })
  await expect(orcaPage.getByRole('dialog')).toContainText('프로젝트 제거')
  await expect(orcaPage.getByRole('checkbox', { name: '다시 보지 않기' })).toBeVisible()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('project-removal-confirmation-ko-dark.png')
  })
})
