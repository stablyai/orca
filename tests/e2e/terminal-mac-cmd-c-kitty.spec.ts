/**
 * macOS Cmd+C routing: with an xterm selection Orca copies it; without one a
 * Kitty-keyboard TUI (e.g. Codex fullscreen transcript, which owns mouse
 * selection) must receive Super+C so it can copy its own selection.
 */

import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  waitForActivePanePtyId,
  focusActiveTerminalInput
} from './helpers/terminal'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'

async function withActiveTerminal(page: Page, action: 'selectAll' | 'kitty7' | 'kitty0') {
  await page.evaluate(async (action) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const terminal = (manager?.getActivePane?.() ?? manager?.getPanes?.()[0])?.terminal
    if (!terminal) {
      throw new Error('No active terminal pane')
    }
    if (action === 'selectAll') {
      terminal.selectAll()
      return
    }
    await new Promise<void>((resolve) => {
      terminal.write(action === 'kitty7' ? '\x1b[=7u' : '\x1b[=0u', resolve)
    })
  }, action)
}

test.describe('macOS Cmd+C with Kitty keyboard reporting', () => {
  test.beforeEach(async ({ orcaPage }) => {
    test.skip(process.platform !== 'darwin', 'Cmd+C copy routing is macOS-only')
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  test('sends Super+C only when xterm has no selection', async ({ orcaPage, electronApp }) => {
    await installTerminalPtyWriteSpy(electronApp)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await execInTerminal(orcaPage, ptyId, 'echo COPY_PROBE_123')
    await waitForTerminalOutput(orcaPage, 'COPY_PROBE_123')
    // Why: flags 7 is what Codex negotiates on terminals it does not recognize.
    await withActiveTerminal(orcaPage, 'kitty7')

    await clearTerminalPtyWriteLog(electronApp)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press('Meta+c')
    await expect
      .poll(async () => (await readTerminalPtyWrites(electronApp)).includes('\x1b[99;9u'), {
        timeout: 5_000,
        message: 'Cmd+C without an xterm selection did not reach the PTY as Super+C'
      })
      .toBe(true)

    await withActiveTerminal(orcaPage, 'selectAll')
    await clearTerminalPtyWriteLog(electronApp)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press('Meta+c')
    await orcaPage.waitForTimeout(300)
    expect((await readTerminalPtyWrites(electronApp)).join('')).not.toContain('\x1b[99')
    await withActiveTerminal(orcaPage, 'kitty0')
  })
})
