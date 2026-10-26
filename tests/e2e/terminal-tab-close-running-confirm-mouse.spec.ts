// #10142: require middle-click confirmation, actual close on confirm, and one Cmd+W dialog across last-pane→tab delegation.
import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveTabId,
  ensureTerminalVisible
} from './helpers/store'
import {
  execInTerminal,
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

function closeDialogTitle(page: Page) {
  return page.getByText(/Stop running command\?|Stop this agent\?/)
}

async function startBusyTerminal(page: Page): Promise<string> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const hasPaneManager = await waitForActiveTerminalManager(page, 30_000)
    .then(() => true)
    .catch(() => false)
  test.skip(!hasPaneManager, 'Electron automation never mounted the live TerminalPane manager.')
  await waitForPaneCount(page, 1, 30_000)

  const ptyId = await waitForActivePanePtyId(page)
  await execInTerminal(page, ptyId, 'echo close-confirm-ready')
  await waitForTerminalOutput(page, 'close-confirm-ready', 20_000)
  await execInTerminal(page, ptyId, 'sleep 300')
  // Wait for sleep itself: macOS login already counts as a child before the command starts.
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId)).foregroundProcess,
      { timeout: 20_000, message: 'sleep 300 never became the foreground process' }
    )
    .toBe('sleep')
  return (await getActiveTabId(page))!
}

test.describe.configure({ mode: 'serial' })

test('middle-clicking a busy tab prompts, and cancelling keeps the tab', async ({ orcaPage }) => {
  test.setTimeout(120_000)
  const busyTabId = await startBusyTerminal(orcaPage)
  const busyTab = orcaPage.locator(`${SORTABLE_TAB}[data-tab-id="${busyTabId}"]`).first()
  const tabsBefore = await orcaPage.locator(SORTABLE_TAB).count()

  await busyTab.click({ button: 'middle' })

  await expect(closeDialogTitle(orcaPage)).toBeVisible({ timeout: 15_000 })
  await orcaPage.getByRole('button', { name: /^Cancel$/ }).click()
  await expect(closeDialogTitle(orcaPage)).toBeHidden()
  await expect(busyTab).toBeVisible()
  expect(await orcaPage.locator(SORTABLE_TAB).count()).toBe(tabsBefore)
})

test('confirming the X-button prompt closes the busy tab', async ({ orcaPage }) => {
  test.setTimeout(120_000)
  const busyTabId = await startBusyTerminal(orcaPage)
  const busyTab = orcaPage.locator(`${SORTABLE_TAB}[data-tab-id="${busyTabId}"]`).first()

  await busyTab.hover()
  await busyTab.getByRole('button', { name: /^Close tab /i }).click()
  await expect(closeDialogTitle(orcaPage)).toBeVisible({ timeout: 15_000 })
  await orcaPage.getByRole('button', { name: /^Stop and Close$/ }).click()

  await expect(busyTab).toHaveCount(0, { timeout: 15_000 })
  await expect(closeDialogTitle(orcaPage)).toBeHidden()
})

test('Cmd+W on a busy single-pane tab raises exactly one dialog', async ({ orcaPage }) => {
  test.setTimeout(120_000)
  const busyTabId = await startBusyTerminal(orcaPage)
  const busyTab = orcaPage.locator(`${SORTABLE_TAB}[data-tab-id="${busyTabId}"]`).first()

  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  await expect(closeDialogTitle(orcaPage)).toBeVisible({ timeout: 15_000 })
  await orcaPage.getByRole('button', { name: /^Stop and Close$/ }).click()

  await expect(busyTab).toHaveCount(0, { timeout: 15_000 })
  // Reject duplicate pane and delegated closeTerminalTab confirmations.
  await orcaPage.waitForTimeout(1_500)
  await expect(closeDialogTitle(orcaPage)).toBeHidden()
})
