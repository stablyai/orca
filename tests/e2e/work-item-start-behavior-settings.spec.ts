import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

async function openTasksSettings(page: Parameters<typeof waitForSessionReady>[0]): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'tasks', repoId: null })
    store.getState().openSettingsPage()
  })

  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await expect(
    page
      .locator('[data-settings-section="tasks"]')
      .getByRole('heading', { name: 'Task Sources', exact: true })
  ).toBeInViewport({ timeout: 10_000 })
}

test('persists the opt-in work item Start behavior', async ({ orcaPage }, testInfo) => {
  await waitForSessionReady(orcaPage)
  await openTasksSettings(orcaPage)

  const behavior = orcaPage.getByRole('radiogroup', { name: 'Work item Start behavior' })
  const draft = behavior.getByRole('radio', { name: 'Draft' })
  const submitAfterReady = behavior.getByRole('radio', { name: 'Submit after ready' })

  await expect(draft).toHaveAttribute('aria-checked', 'true')
  await expect(submitAfterReady).toHaveAttribute('aria-checked', 'false')

  await submitAfterReady.click()
  await expect(submitAfterReady).toHaveAttribute('aria-checked', 'true')
  await expect
    .poll(async () => orcaPage.evaluate(() => window.api.settings.get()))
    .toMatchObject({ workItemStartPromptDelivery: 'submit-after-ready' })

  await testInfo.attach('work-item-start-behavior-settings', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
})
