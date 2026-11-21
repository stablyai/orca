// An agent copy's ID field: its agent prefix is fixed, only the suffix edits, and the whole id
// still selects and copies as one string.
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'

const savedCopyIds = (page: Page) =>
  page.evaluate(() => window.__store?.getState().settings?.agentCopies?.map((copy) => copy.id))

test("an agent copy's ID keeps its prefix and copies as one string", async ({
  orcaPage: page,
  electronApp
}) => {
  // A cold Orca start, then a settings save; the default 60s is tight on CI.
  test.setTimeout(120_000)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await page.evaluate(async () => {
    await window.__store?.getState().updateSettings({
      agentCopies: [{ id: 'claude.code-mode', name: 'Claude Code Mode', agent: 'claude' }]
    })
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: 'agents', repoId: null })
    state?.openSettingsPage()
  })
  const toggle = page.getByRole('button', { name: 'Claude Code Mode', exact: true })
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await toggle.click({ force: true })
  const field = page.getByRole('textbox', { name: 'Copy ID' })
  await expect(field).toHaveValue('claude.code-mode', { timeout: 15_000 })

  // A double-click selects the whole id, prefix included, and Ctrl+C copies it as one string.
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''))
  await field.dblclick({ force: true })
  await page.keyboard.press('Control+C')
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('claude.code-mode')

  // Typing over the whole selection replaces only the suffix.
  await field.dblclick({ force: true })
  await page.keyboard.type('fast')
  await expect(field).toHaveValue('claude.fast')
  // Backspace stops at the prefix.
  await page.keyboard.press('End')
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Backspace')
  }
  await expect(field).toHaveValue('claude.')
  await expect(page.getByText('Use lowercase letters, digits and dashes.')).toBeVisible()

  // A pasted whole id keeps only its suffix, and saves under the same prefix.
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('claude.pasted'))
  await page.keyboard.press('Control+V')
  await expect(field).toHaveValue('claude.pasted')
  await page.keyboard.press('Enter')
  await expect.poll(() => savedCopyIds(page)).toEqual(['claude.pasted'])
})
