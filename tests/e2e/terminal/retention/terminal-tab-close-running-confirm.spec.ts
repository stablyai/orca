// #10142: keyboard and X close must both confirm for the same live sleep 300 child, preserving the tab until approval.
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import type { Page } from '@stablyai/playwright-test'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveTabId,
  ensureTerminalVisible
} from '../../desktop/renderer-probes/store'
import { focusActiveTerminalInput, waitForActivePanePtyId } from '../input/terminal'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from '../layout/terminal-pane-operations'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

function countRenderedTabs(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

function closeDialog(page: Page) {
  return page.getByRole('dialog').filter({
    has: page.getByRole('button', { name: /^Stop and close$/i })
  })
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
  // Wait for sleep as foreground process; macOS login makes hasChildProcesses true before the command starts.
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

  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  await expect(closeDialog(orcaPage)).toBeVisible({ timeout: 15_000 })
  await orcaPage.getByRole('button', { name: /^Cancel$/ }).click()
  await expect(closeDialog(orcaPage)).toBeHidden()
  await expect(busyTab).toBeVisible()
  const tabsBefore = await countRenderedTabs(orcaPage)

  await busyTab.hover()
  await busyTab.getByRole('button', { name: /^Close tab /i }).click()
  await orcaPage.waitForTimeout(1_500)

  expect(
    {
      confirmDialogVisible: await closeDialog(orcaPage).isVisible(),
      tabStillPresent: (await countRenderedTabs(orcaPage)) === tabsBefore
    },
    'X-button close must apply the same running-process confirmation as Cmd+W'
  ).toEqual({ confirmDialogVisible: true, tabStillPresent: true })
})
