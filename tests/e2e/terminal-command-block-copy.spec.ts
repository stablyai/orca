import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.beforeEach(async ({ orcaPage }, testInfo) => {
  testInfo.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
})

async function rightClickBufferText(orcaPage: Page, needle: string): Promise<void> {
  const point = await orcaPage.evaluate((text) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const terminal = pane?.terminal
    if (!terminal) {
      return null
    }
    const buffer = terminal.buffer.active
    let matchRow: number | null = null
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row)
      // Last match wins: the typed echo repeats the marker before the output.
      if (line && line.translateToString(true).includes(text)) {
        matchRow = row
      }
    }
    if (matchRow === null) {
      return null
    }
    const screen = terminal.element?.querySelector('.xterm-screen')
    if (!screen) {
      return null
    }
    const rect = screen.getBoundingClientRect()
    const cellHeight = rect.height / terminal.rows
    const viewportRow = matchRow - buffer.viewportY
    return {
      x: rect.left + Math.min(120, rect.width / 2),
      y: rect.top + viewportRow * cellHeight + cellHeight / 2
    }
  }, needle)
  if (!point) {
    throw new Error(`terminal output does not contain ${needle}`)
  }
  await orcaPage.mouse.click(point.x, point.y, { button: 'right' })
}

test('terminal context menu copies a shell command block output', async ({ orcaPage }) => {
  const marker = `ORCA_E2E_CMD_BLOCK_${Date.now()}`
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await sendToTerminal(
    orcaPage,
    ptyId,
    `printf '\\x1b]133;A\\x1b\\\\$ \\x1b]133;B\\x1b\\\\echo ${marker}\\r\\n\\x1b]133;C\\x1b\\\\${marker}\\r\\n\\x1b]133;D;0\\x1b\\\\'\r`
  )
  await waitForTerminalOutput(orcaPage, marker, 10_000)

  await rightClickBufferText(orcaPage, marker)
  const copyOutput = orcaPage.getByRole('menuitem', { name: 'Copy Output', exact: true })
  await expect(copyOutput).toBeVisible()
  await expect(copyOutput).toBeEnabled()
  await expect(orcaPage.getByRole('menuitem', { name: 'Copy Command', exact: true })).toBeVisible()
  await expect(
    orcaPage.getByRole('menuitem', { name: 'Copy Command and Output', exact: true })
  ).toBeVisible()
  await copyOutput.click()
  await expect
    .poll(() => orcaPage.evaluate(() => window.api.ui.readClipboardText()), {
      timeout: 5_000
    })
    .toBe(marker)
})
