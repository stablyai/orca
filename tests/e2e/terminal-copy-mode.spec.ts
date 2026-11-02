import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import {
  execInTerminal,
  focusActiveTerminalInput,
  resolveActiveTabId,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'
import {
  configureCopyMode,
  copiedModeText,
  copyCursorPosition,
  expectCopyCursorReady,
  expectCopyCursorCell,
  pressCopyMotion,
  expectHiddenCopyModeWindow,
  isolateCopyModeClipboard,
  seedCopyModeScreen,
  startCopyModeTerminalProbe
} from './helpers/terminal-copy-mode-fixture'

test.beforeEach(async ({ orcaPage, electronApp }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  await isolateCopyModeClipboard(electronApp)
  await startCopyModeTerminalProbe(orcaPage)
  await seedCopyModeScreen(orcaPage)
})

test('copy mode freezes output, draws its cursor and copies without sending mode keys to the PTY', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await orcaPage.evaluate(() => window.__store?.getState().updateSettingsOrThrow({ theme: 'dark' }))
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await installTerminalPtyWriteSpy(electronApp)
  await clearTerminalPtyWriteLog(electronApp)
  await pressShortcut(orcaPage, 'x', { shift: true })
  const mode = orcaPage.getByRole('region', { name: 'Copy mode', exact: true })
  await expect(mode).toBeVisible()
  await expectCopyCursorReady(orcaPage)
  await expect(mode.locator('.xterm-accessibility-tree')).toContainText('COPY_MODE_ALPHA')
  await expect(
    mode.locator('.xterm-screen canvas:not(.xterm-link-layer), .xterm-rows')
  ).toHaveCount(1)
  await expect(mode.locator('.terminal-copy-mode-cursor')).toBeInViewport()
  const initial = await copyCursorPosition(orcaPage)
  await orcaPage.keyboard.press('l')
  expect((await copyCursorPosition(orcaPage)).x).toBeGreaterThan(initial.x)
  await orcaPage.keyboard.press('j')
  expect((await copyCursorPosition(orcaPage)).y).toBeGreaterThan(initial.y)
  await orcaPage.keyboard.press('k')
  await orcaPage.keyboard.press('h')
  expect(await copyCursorPosition(orcaPage)).toEqual(initial)
  expect(await readTerminalPtyWrites(electronApp)).toEqual([])

  const ptyId = await waitForActivePanePtyId(orcaPage)
  await execInTerminal(orcaPage, ptyId, 'echo COPY_MODE_LIVE_OUTPUT')
  await waitForTerminalOutput(orcaPage, 'COPY_MODE_LIVE_OUTPUT')
  await expect(mode.locator('.xterm-accessibility-tree')).not.toContainText('COPY_MODE_LIVE_OUTPUT')
  await clearTerminalPtyWriteLog(electronApp)
  const bounds = await mode.locator('.xterm-screen').boundingBox()
  const cell = await mode.locator('.terminal-copy-mode-cursor').evaluate((element) => ({
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height)
  }))
  if (!bounds) {
    throw new Error('No copy-mode screen for selection paint')
  }
  const clip = {
    x: bounds.x + cell.width * 1.5,
    y: bounds.y + cell.height - 1,
    width: 1,
    height: 1
  }
  const unselected = PNG.sync.read(await orcaPage.screenshot({ clip })).data
  await orcaPage.keyboard.press('v')
  await orcaPage.keyboard.press('l')
  await orcaPage.keyboard.press('l')
  await orcaPage.keyboard.press('l')
  await expect(mode.getByRole('status')).toHaveText('Copy mode · Selecting')
  await expect
    .poll(async () => PNG.sync.read(await orcaPage.screenshot({ clip })).data.equals(unselected))
    .toBe(false)
  await expectHiddenCopyModeWindow(electronApp)
  await orcaPage.screenshot({ path: testInfo.outputPath('copy-mode-selection.png') })
  await orcaPage.keyboard.press('y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('COPY')
  await expect(mode).toHaveCount(0)
  expect(await readTerminalPtyWrites(electronApp)).toEqual([])
  const tabId = await resolveActiveTabId(orcaPage)
  await expect(
    orcaPage.locator(`[data-terminal-tab-id="${tabId}"] .xterm-accessibility-tree`).first()
  ).toContainText('COPY_MODE_LIVE_OUTPUT')
})

test('palette entry and custom controls retain the selection after copying and clipboard failure', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await configureCopyMode(orcaPage, {
    keybindings: { 'terminal.enterCopyMode': ['Mod+Shift+Y'] },
    copyMode: {
      exitOnCopy: false,
      bindings: {
        left: ['a'],
        down: ['s'],
        up: ['w'],
        right: ['d'],
        toggleSelection: ['Space'],
        copy: ['Enter'],
        exit: ['Escape']
      }
    }
  })
  await orcaPage.getByRole('button', { name: 'Search worktrees and browser tabs' }).click()
  await orcaPage.getByRole('combobox').fill('Enter Copy Mode')
  await orcaPage.getByRole('option', { name: /^Enter Copy Mode/ }).click()
  await expect(orcaPage.locator('[role="dialog"]')).toHaveCount(0)
  const mode = orcaPage.locator('.terminal-copy-mode')
  await expectCopyCursorReady(orcaPage)
  await expect(mode).toContainText('Space')
  await expect(mode).toContainText('Enter')
  await orcaPage.keyboard.press('Space')
  await orcaPage.keyboard.press('d')
  await orcaPage.keyboard.press('d')
  await orcaPage.keyboard.press('Enter')
  await expect.poll(() => copiedModeText(electronApp)).toBe('COP')
  await expect(mode).toBeVisible()
  await electronApp.evaluate(() => {
    process.env.ORCA_E2E_COPY_MODE_FAIL = '1'
  })
  await orcaPage.keyboard.press('Enter')
  await expect(orcaPage.getByText('Could not copy terminal selection. Try again.')).toBeVisible()
  await expect(mode.getByRole('status')).toHaveText('Copy mode · Selecting')
  await orcaPage.screenshot({ path: testInfo.outputPath('copy-mode-custom-controls.png') })
  await orcaPage.keyboard.press('Escape')
  await expect(mode).toHaveCount(0)
  await focusActiveTerminalInput(orcaPage)
  await pressShortcut(orcaPage, 'y', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await orcaPage.keyboard.press('Escape')
  await expect(mode).toHaveCount(0)
})

test('wide and combined characters remain whole in reverse selections and after resizing', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await configureCopyMode(orcaPage, { copyMode: { exitOnCopy: false } })
  await seedCopyModeScreen(orcaPage, 'a中e\u0301b\r\nsecond line')
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await orcaPage.keyboard.press('l')
  const wide = await copyCursorPosition(orcaPage)
  await orcaPage.keyboard.press('l')
  const combined = await copyCursorPosition(orcaPage)
  expect(combined.x - wide.x).toBeCloseTo(wide.width, 0)
  await orcaPage.keyboard.press('l')
  await orcaPage.keyboard.press('v')
  await orcaPage.keyboard.press('h')
  await orcaPage.keyboard.press('h')
  await orcaPage.setViewportSize({ width: 1100, height: 720 })
  await expectCopyCursorReady(orcaPage)
  await orcaPage.keyboard.press('y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('中e\u0301b')
  await expect(orcaPage.locator('.terminal-copy-mode')).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('copy-mode-wide-selection.png') })
  await orcaPage.keyboard.press('q')
  await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
})

test('alternate-screen snapshots exclude hidden history and clean up when switching split panes', async ({
  orcaPage,
  electronApp
}) => {
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  await startCopyModeTerminalProbe(orcaPage)
  await seedCopyModeScreen(orcaPage, 'HIDDEN_NORMAL_HISTORY')
  const tabId = await resolveActiveTabId(orcaPage)
  await orcaPage.evaluate(async (tabId) => {
    const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
    if (!pane) {
      throw new Error('No active terminal pane')
    }
    await new Promise<void>((resolve) =>
      pane.terminal.write('\x1b[?1049h\x1b[HALTERNATE_SCREEN\x1b[1;1H', resolve)
    )
    pane.terminal.focus()
  }, tabId)
  await installTerminalPtyWriteSpy(electronApp)
  await clearTerminalPtyWriteLog(electronApp)
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  const mode = orcaPage.locator('.terminal-copy-mode')
  await expect(mode.locator('.xterm-accessibility-tree')).toContainText('ALTERNATE_SCREEN')
  await expect(mode.locator('.xterm-accessibility-tree')).not.toContainText('HIDDEN_NORMAL_HISTORY')
  await orcaPage.setViewportSize({ width: 1100, height: 720 })
  await expectCopyCursorReady(orcaPage)
  await expect(mode.locator('.xterm-accessibility-tree')).toContainText('ALTERNATE_SCREEN')
  await expect(mode.locator('.xterm-accessibility-tree')).not.toContainText('HIDDEN_NORMAL_HISTORY')
  await orcaPage.keyboard.down('q')
  await expect(mode).toHaveCount(0)
  await orcaPage.keyboard.down('q')
  await orcaPage.keyboard.up('q')
  expect(await readTerminalPtyWrites(electronApp)).toEqual([])
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await pressShortcut(orcaPage, ']')
  await expect(mode).toHaveCount(0)
  await expect(orcaPage.locator(`[data-terminal-tab-id="${tabId}"] .pane .xterm`)).toHaveCount(2)
  await expectHiddenCopyModeWindow(electronApp)
})

test('older keybinding snapshots retain custom controls and receive missing Vim motion defaults', async ({
  orcaPage,
  electronApp
}) => {
  const snapshot = await orcaPage.evaluate(() => window.api.keybindings.get())
  const olderSnapshot = {
    ...snapshot,
    copyMode: {
      exitOnCopy: false,
      bindings: {
        left: ['H'],
        right: ['L'],
        up: ['W'],
        down: ['J'],
        toggleSelection: ['V'],
        copy: ['Y'],
        exit: ['Escape', 'Q']
      }
    }
  }
  await electronApp.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler('keybindings:get')
    ipcMain.handle('keybindings:get', () => value)
  }, olderSnapshot)
  await orcaPage.evaluate(() => window.__store?.getState().fetchKeybindings())
  await seedCopyModeScreen(orcaPage, 'first second\r\nnext')
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await pressCopyMotion(orcaPage, 'j w')
  await expectCopyCursorCell(orcaPage, 0, 0)
  await pressCopyMotion(orcaPage, '$')
  await expectCopyCursorCell(orcaPage, 0, 11)
  await pressCopyMotion(orcaPage, '0 e e g e')
  await expectCopyCursorCell(orcaPage, 0, 4)
  await pressCopyMotion(orcaPage, '0 v $ y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('first second')
  await expect(orcaPage.locator('.terminal-copy-mode')).toBeVisible()
})
