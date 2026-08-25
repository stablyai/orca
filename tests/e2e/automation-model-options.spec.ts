import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const AUTOMATION_NAME = 'synthetic-model-options-demo'

test('automation model preferences render in detail and remain editable', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1200, height: 760 })

  await orcaPage.evaluate(async (name) => {
    const store = window.__store
    const repo = store?.getState().repos[0]
    if (!store || !repo) {
      throw new Error('Seeded test repo is not available')
    }
    await window.api.automations.create({
      name,
      prompt: 'Review the repository with the selected model.',
      agentId: 'codex',
      launchPreferences: { model: 'gpt-5.6-sol', effort: 'high' },
      projectId: repo.id,
      workspaceMode: 'new_per_run',
      reuseSession: false,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.now(),
      enabled: false,
      missedRunGraceMinutes: 720
    })
    store.getState().openAutomationsPage()
  }, AUTOMATION_NAME)

  await orcaPage.getByRole('button', { name: new RegExp(`^${AUTOMATION_NAME}`) }).click()
  await expect(orcaPage.getByText('GPT-5.6 Sol', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('high', { exact: true })).toBeVisible()

  await orcaPage.getByRole('button', { name: 'Edit automation' }).click()
  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog.getByText('Model', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Effort', { exact: true })).toBeVisible()
  await expect(dialog.getByText('GPT-5.6 Sol', { exact: true })).toBeVisible()
  await expect(dialog.getByText('High', { exact: true })).toBeVisible()
  await dialog.screenshot({ path: testInfo.outputPath('automation-model-options.png') })
})
