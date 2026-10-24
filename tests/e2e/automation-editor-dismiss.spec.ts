import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { waitForSessionReady } from './helpers/store'

const EXISTING_NAME = 'disabled-dismiss-regression'

// Keep every Electron launch in this spec in the background, including local runs.
test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

async function openAutomations(page: Page, seedAutomation = false): Promise<void> {
  await waitForSessionReady(page)
  await page.evaluate(
    async ({ seedAutomation, name }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateSettings({ uiLanguage: 'en' })
      if (seedAutomation) {
        const repo = store.getState().repos[0]
        if (!repo) {
          throw new Error('Seeded test repo is not available')
        }
        // Real persisted automation, disabled so this regression never launches an agent.
        const response = await window.api.runtime.call({
          method: 'automation.create',
          params: {
            name,
            prompt: 'Synthetic dismissal regression fixture.',
            agentId: 'codex',
            repo: `id:${repo.id}`,
            workspaceMode: 'new_per_run',
            reuseSession: false,
            timezone: 'UTC',
            rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
            dtstart: Date.now(),
            enabled: false,
            missedRunGraceMinutes: 720
          }
        })
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
      }
      store.getState().openAutomationsPage()
    },
    { seedAutomation, name: EXISTING_NAME }
  )
  await expect(page.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible()
  await dismissTransientAnnouncement(page)
}

async function clickBackdrop(page: Page): Promise<void> {
  await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 8, y: 8 } })
}

test('new automation draft survives the backdrop and a reverted draft can close', async ({
  orcaPage
}, testInfo) => {
  await openAutomations(orcaPage)
  await orcaPage.getByRole('button', { name: 'New Automation', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: 'Create automation', exact: true })
  const name = dialog.getByRole('textbox', { name: 'Automation name', exact: true })
  await expect(name).toBeVisible()
  const initialName = await name.inputValue()
  await name.fill('Unsaved automation draft')
  await clickBackdrop(orcaPage)
  // data-state avoids passing during the exit animation of an incorrectly dismissed dialog.
  await expect(dialog).toHaveAttribute('data-state', 'open')
  await expect(name).toHaveValue('Unsaved automation draft')
  await testInfo.attach('create-draft-after-backdrop', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })

  await name.fill(initialName)
  await clickBackdrop(orcaPage)
  await expect(dialog).toBeHidden()
})

test('Cancel, close button, and Escape explicitly discard a dirty new automation', async ({
  orcaPage
}) => {
  await openAutomations(orcaPage)
  const open = orcaPage.getByRole('button', { name: 'New Automation', exact: true })
  const dialog = orcaPage.getByRole('dialog', { name: 'Create automation', exact: true })
  for (const action of ['Cancel', 'Close', 'Escape'] as const) {
    await open.click()
    const name = dialog.getByRole('textbox', { name: 'Automation name', exact: true })
    await expect(name).toBeVisible()
    const initialName = await name.inputValue()
    await name.fill(`Discard through ${action}`)
    await (action === 'Escape'
      ? orcaPage.keyboard.press('Escape')
      : dialog.getByRole('button', { name: action, exact: true }).click())
    await expect(dialog).toBeHidden()
    await open.click()
    await expect(name).toHaveValue(initialName)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
})

test('existing disabled automation keeps changes on backdrop and closes after reverting', async ({
  orcaPage
}, testInfo) => {
  await openAutomations(orcaPage, true)
  await orcaPage.getByRole('button', { name: new RegExp(`^${EXISTING_NAME}`) }).click()
  await orcaPage.getByRole('button', { name: 'Edit automation', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: 'Edit automation', exact: true })
  const name = dialog.getByRole('textbox', { name: 'Automation name', exact: true })
  await expect(name).toHaveValue(EXISTING_NAME)
  await name.fill(`${EXISTING_NAME} changed`)
  await clickBackdrop(orcaPage)
  await expect(dialog).toHaveAttribute('data-state', 'open')
  await expect(name).toHaveValue(`${EXISTING_NAME} changed`)
  await testInfo.attach('edit-draft-after-backdrop', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })

  await name.fill(EXISTING_NAME)
  await clickBackdrop(orcaPage)
  await expect(dialog).toBeHidden()
  await orcaPage.getByRole('button', { name: 'Edit automation', exact: true }).click()
  await expect(name).toHaveValue(EXISTING_NAME)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
})
