/**
 * Regression for #10142: keyboard and mouse enforce the same running-process close
 * confirmation. Both halves run against one tab with a live `sleep 300` child:
 *   1. Cmd/Ctrl+W -> "Stop running command?" dialog (cancelled, tab survives).
 *   2. X click    -> the same dialog, and the tab is still there behind it.
 */
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

function countRenderedTabs(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

function closeDialogTitle(page: Page) {
  return page.getByText(/Stop running command\?|Stop this agent\?/)
}

test.describe.configure({ mode: 'serial' })

test('the tab X button applies the same running-process confirmation as Cmd+W', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
    .then(() => true)
    .catch(() => false)
  test.skip(!hasPaneManager, 'Electron automation never mounted the live TerminalPane manager.')
  await waitForPaneCount(orcaPage, 1, 30_000)

  const ptyId = await waitForActivePanePtyId(orcaPage)
  await execInTerminal(orcaPage, ptyId, 'echo repro-10142-ready')
  await waitForTerminalOutput(orcaPage, 'repro-10142-ready', 20_000)
  await execInTerminal(orcaPage, ptyId, 'sleep 300')
  // Only press close once `sleep` is the foreground process; otherwise the probe
  // legitimately sees an idle shell and closing is correct. `hasChildProcesses` alone is
  // not enough: macOS spawns the shell under `login`, so a still-initialising terminal
  // reports a child before `sleep 300` has run.
  await expect
    .poll(
      async () =>
        (await orcaPage.evaluate((id) => window.api.pty.inspectProcess(id), ptyId))
          .foregroundProcess,
      { timeout: 20_000, message: 'sleep 300 never became the foreground process' }
    )
    .toBe('sleep')

  const busyTabId = (await getActiveTabId(orcaPage))!
  const busyTab = orcaPage.locator(`${SORTABLE_TAB}[data-tab-id="${busyTabId}"]`).first()

  // 1. Keyboard close prompts.
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  await expect(closeDialogTitle(orcaPage)).toBeVisible({ timeout: 15_000 })
  await orcaPage.getByRole('button', { name: /^Cancel$/ }).click()
  await expect(closeDialogTitle(orcaPage)).toBeHidden()
  await expect(busyTab).toBeVisible()
  const tabsBefore = await countRenderedTabs(orcaPage)

  // 2. Same tab, same running child, mouse close.
  await busyTab.hover()
  await busyTab.getByRole('button', { name: /^Close tab /i }).click()
  await orcaPage.waitForTimeout(1_500)

  expect(
    {
      confirmDialogVisible: await closeDialogTitle(orcaPage).isVisible(),
      tabStillPresent: (await countRenderedTabs(orcaPage)) === tabsBefore
    },
    'X-button close must apply the same running-process confirmation as Cmd+W'
  ).toEqual({ confirmDialogVisible: true, tabStillPresent: true })
})
