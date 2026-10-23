/**
 * E2E coverage for the Automations page create / edit / delete wizard.
 *
 * The create, edit, and delete flows drive the real editor and confirm dialogs;
 * the store seeds a pre-existing definition only where an edit or delete needs a
 * record that already exists. Every final assertion is DOM-visible, never a
 * store round-trip.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const AUTOMATION_RRULE = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'

async function openAutomations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().openAutomationsPage()
  })
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible()
}

async function seedAutomation(page: Page, name: string, prompt: string): Promise<void> {
  await page.evaluate(
    async ({ name, prompt, rrule }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const repo = store.getState().repos[0]
      if (!repo) {
        throw new Error('Seeded test repo is not available')
      }
      const response = await window.api.runtime.call({
        method: 'automation.create',
        params: {
          agentId: 'codex',
          name,
          prompt,
          repo: `id:${repo.id}`,
          workspaceMode: 'new_per_run',
          reuseSession: false,
          timezone: 'UTC',
          rrule,
          dtstart: Date.now(),
          enabled: false,
          missedRunGraceMinutes: 720
        }
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
    },
    { name, prompt, rrule: AUTOMATION_RRULE }
  )
}

async function openCreateDialog(page: Page) {
  const createButton = page.getByRole('button', { name: 'New Automation' })
  await expect(createButton).toBeEnabled({ timeout: 30_000 })
  await createButton.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Create automation' })).toBeVisible()
  return dialog
}

async function openRowDetail(page: Page, name: string): Promise<void> {
  const row = page.getByRole('button', { name: new RegExp(`^${name}`) })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

async function typePrompt(page: Page, text: string): Promise<void> {
  const promptEditor = page.locator('[data-slot="automation-prompt-editor"] .monaco-editor')
  await expect(promptEditor).toBeVisible({ timeout: 20_000 })
  await promptEditor.click()
  await page.keyboard.insertText(text)
}

async function selectCadence(page: Page, label: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Cadence' }).click()
  await page.getByRole('listbox').getByRole('option', { name: label }).click()
}

test('opening Automations shows the list and the create form fields', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await openAutomations(orcaPage)

  const dialog = await openCreateDialog(orcaPage)
  await expect(dialog.getByRole('textbox', { name: 'Automation name' })).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: 'Prompt' })).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Cadence' })).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Host' })).toBeVisible()
  await expect(dialog.getByText('Project', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Agent', { exact: true })).toBeVisible()
  await expect(dialog.locator('button[data-agent-combobox-root="true"]').first()).toBeVisible()
})

test('creating an automation through the wizard adds it to the list', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await openAutomations(orcaPage)

  const name = `e2e-create-automation-${Date.now()}`
  const dialog = await openCreateDialog(orcaPage)
  await dialog.getByRole('textbox', { name: 'Automation name' }).fill(name)
  await selectCadence(orcaPage, 'Daily')
  await typePrompt(orcaPage, 'Summarize the seeded repository status.')

  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect(orcaPage.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible({
    timeout: 20_000
  })
})

test('editing an automation persists the new name', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const stamp = Date.now()
  const originalName = `e2e-edit-original-${stamp}`
  const updatedName = `e2e-edit-updated-${stamp}`
  await seedAutomation(orcaPage, originalName, 'Original prompt for the edit flow.')
  await openAutomations(orcaPage)
  await openRowDetail(orcaPage, originalName)

  await orcaPage.getByRole('button', { name: 'Edit automation' }).click()
  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Edit automation' })).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Automation name' }).fill(updatedName)
  await dialog.getByRole('button', { name: 'Save Changes' }).click()
  await expect(dialog).toBeHidden()

  await expect(orcaPage.getByRole('heading', { name: updatedName })).toBeVisible({
    timeout: 20_000
  })
})

test('deleting an automation asks for confirmation and removes it', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const name = `e2e-delete-automation-${Date.now()}`
  await seedAutomation(orcaPage, name, 'Delete flow prompt.')
  await openAutomations(orcaPage)
  await openRowDetail(orcaPage, name)

  await orcaPage.getByRole('button', { name: 'Delete automation' }).click()
  const confirmDialog = orcaPage.getByRole('dialog')
  await expect(confirmDialog.getByRole('heading', { name: 'Delete Automation' })).toBeVisible()
  await confirmDialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirmDialog).toBeHidden()

  await expect(orcaPage.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0, {
    timeout: 20_000
  })
  await expect(orcaPage.getByRole('button', { name: 'New Automation' })).toBeVisible()
})

test('the schedule cadence choice toggles the trigger form', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await openAutomations(orcaPage)

  const dialog = await openCreateDialog(orcaPage)
  const cadence = dialog.getByRole('combobox', { name: 'Cadence' })
  await expect(cadence).toContainText('Weekdays')

  await selectCadence(orcaPage, 'Custom cron')
  await expect(dialog.getByText('Cron expression', { exact: true })).toBeVisible()
  const cronInput = dialog.getByPlaceholder('0 9 * * 1-5')
  await expect(cronInput).toBeVisible()
  await cronInput.fill('15 3 * * 1-5')
  await expect(cronInput).toHaveValue('15 3 * * 1-5')

  await selectCadence(orcaPage, 'Daily')
  await expect(dialog.getByText('Cron expression', { exact: true })).toHaveCount(0)
  await expect(cadence).toContainText('Daily')
})
