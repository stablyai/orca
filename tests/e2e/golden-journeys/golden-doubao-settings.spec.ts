import { expect, type Page } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import { ensureTerminalVisible } from '../desktop/renderer-probes/store'
import { expectTerminalAccessibilityText } from '../terminal/input/terminal-accessibility-tree'
import { getTerminalContent } from '../terminal/layout/terminal-pane-identity'
import {
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_READY_MARKER,
  launchGoldenStubAgentFromNewTab
} from './golden-stub-agent'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

async function openDoubaoSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  const row = page.locator('[data-agent-inventory-state="ready"] #settings-agent-doubao')
  const details = row.getByRole('button', { name: 'Doubao', exact: true })
  if ((await details.getAttribute('aria-expanded')) === 'false') {
    await details.click()
  }
  return row
}

test('configures Doubao from Settings and launches the saved CLI from a new tab', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  const row = await openDoubaoSettings(orcaPage)
  const command = row.getByPlaceholder('doubao', { exact: true })
  await command.fill('golden-stub-agent')
  await command.press('Enter')

  const args = row.getByRole('textbox', { name: 'Arguments' })
  await args.fill('--effort medium -C .')
  await args.press('Enter')
  const effortChip = row.getByRole('button', { name: 'Remove --effort medium', exact: true })
  await expect(effortChip).toBeVisible()
  const env = row.getByPlaceholder('No default environment')
  await env.fill('ORCA_GOLDEN_REPORT_ARGS=1')
  await env.press('Enter')
  await expect(row.getByText('ORCA_GOLDEN_REPORT_ARGS=1', { exact: true })).toBeVisible()
  const permission = row.getByRole('button', { name: 'Doubao permissions' })
  await permission.click()
  await orcaPage.getByRole('menuitemradio', { name: /^Ask for approval/ }).click()
  await expect(permission).toHaveText('Ask for approval')

  const close = orcaPage.getByRole('button', { name: 'Close settings' })
  await close.click()
  await orcaPage.reload()
  await openDoubaoSettings(orcaPage)
  await expect(command).toHaveValue('golden-stub-agent')
  await expect(args).toHaveValue('-C .')
  await expect(effortChip).toBeVisible()
  await expect(env).toHaveValue('ORCA_GOLDEN_REPORT_ARGS=1')
  await expect(permission).toHaveText('Ask for approval')
  await close.click()
  await ensureTerminalVisible(orcaPage)
  const selectedTab = orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
  const originalTabId = await selectedTab.getAttribute('data-tab-id')
  await launchGoldenStubAgentFromNewTab(orcaPage, /^Doubao(?:\s|$)/i)
  await expect(selectedTab).not.toHaveAttribute('data-tab-id', originalTabId ?? '')
  const agentTabId = await selectedTab.getAttribute('data-tab-id')
  if (!agentTabId) {
    throw new Error('The selected Doubao terminal tab has no ID')
  }
  await expect(
    orcaPage.locator(`[data-terminal-tab-id="${agentTabId}"] .xterm-screen`)
  ).toBeVisible()
  await expectTerminalAccessibilityText(orcaPage, agentTabId, GOLDEN_STUB_READY_MARKER)
  await expect.poll(() => getTerminalContent(orcaPage)).toContain('"-C","."')
  await expect.poll(() => getTerminalContent(orcaPage)).toContain('"--effort","medium"')
  await expect
    .poll(() => getTerminalContent(orcaPage))
    .toContain('"--permission-mode","ask_always"')
})
