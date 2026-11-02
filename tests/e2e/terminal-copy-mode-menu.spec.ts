import { PNG } from 'pngjs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import { resolveActiveTabId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'
import {
  configureCopyMode,
  copiedModeText,
  expectCopyCursorReady,
  expectHiddenCopyModeWindow,
  isolateCopyModeClipboard,
  seedCopyModeScreen,
  startCopyModeTerminalProbe
} from './helpers/terminal-copy-mode-fixture'

async function dispatchMenuSelection(
  app: ElectronApplication,
  action: 'copy' | 'select-all'
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, action) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('ui:appMenuSelectionAction', action)
    }
  }, action)
}

test.beforeEach(async ({ orcaPage, electronApp }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await isolateCopyModeClipboard(electronApp)
  await startCopyModeTerminalProbe(orcaPage)
  await seedCopyModeScreen(orcaPage, 'FROZEN_ALPHA\r\nsecond line')
  await installTerminalPtyWriteSpy(electronApp)
  await clearTerminalPtyWriteLog(electronApp)
})

test('menu paste is blocked in copy mode and restored after exit and reentry', async ({
  orcaPage,
  electronApp
}) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('clipboard:readText')
    ipcMain.handle('clipboard:readText', () => {
      process.env.ORCA_E2E_MENU_PASTE_READS = String(
        Number(process.env.ORCA_E2E_MENU_PASTE_READS ?? 0) + 1
      )
      return 'MENU_PASTE_PAYLOAD'
    })
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await pressShortcut(orcaPage, 'x', { shift: true })
    await expectCopyCursorReady(orcaPage)
    await orcaPage.evaluate(async () => {
      window.dispatchEvent(new CustomEvent('orca-app-menu-paste', { cancelable: true }))
      await window.api.keybindings.get()
    })
    expect(
      await electronApp.evaluate(() => Number(process.env.ORCA_E2E_MENU_PASTE_READS ?? 0))
    ).toBe(attempt)
    expect(await readTerminalPtyWrites(electronApp)).toEqual([])
    await orcaPage.keyboard.press('q')
    await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('ui:appMenuPaste')
      }
    })
    await expect
      .poll(async () => (await readTerminalPtyWrites(electronApp)).join(''))
      .toContain('MENU_PASTE_PAYLOAD')
    await clearTerminalPtyWriteLog(electronApp)
  }
  await expectHiddenCopyModeWindow(electronApp)
})

test('menu copy and select all use the frozen selection instead of hidden live text', async ({
  orcaPage,
  electronApp
}) => {
  await configureCopyMode(orcaPage, { copyMode: { exitOnCopy: false } })
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  const tabId = await resolveActiveTabId(orcaPage)
  await orcaPage.evaluate(async (tabId) => {
    const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
    if (!pane) {
      throw new Error('No live terminal')
    }
    await new Promise<void>((resolve) =>
      pane.terminal.write('\x1b[2J\x1b[3J\x1b[HHIDDEN_LIVE', resolve)
    )
    pane.terminal.select(0, 0, 11)
  }, tabId)
  await orcaPage.keyboard.press('v')
  await orcaPage.keyboard.press('l')
  await orcaPage.keyboard.press('l')
  await dispatchMenuSelection(electronApp, 'copy')
  await expect.poll(() => copiedModeText(electronApp)).toBe('FRO')
  await expect(orcaPage.locator('.terminal-copy-mode [role="status"]')).toHaveText(
    'Copy mode · Selecting'
  )
  await dispatchMenuSelection(electronApp, 'select-all')
  await dispatchMenuSelection(electronApp, 'copy')
  await expect
    .poll(async () => (await copiedModeText(electronApp))?.trim())
    .toBe('FROZEN_ALPHA\nsecond line')
  await orcaPage.keyboard.press('v')
  await expect(orcaPage.locator('.terminal-copy-mode [role="status"]')).toHaveText('Copy mode')
  expect(await readTerminalPtyWrites(electronApp)).toEqual([])
  await expectHiddenCopyModeWindow(electronApp)
})

for (const remapped of [false, true]) {
  test(`${remapped ? 'Ctrl+Shift' : 'default'} copy and select-all shortcuts use frozen text without a menu event`, async ({
    orcaPage,
    electronApp
  }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('clipboard:readText')
      ipcMain.handle('clipboard:readText', () => 'SHORTCUT_PASTE_PAYLOAD')
    })
    const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
    const modifier = remapped || !isMac ? 'Control+Shift' : 'Meta'
    await configureCopyMode(orcaPage, {
      copyMode: { exitOnCopy: false },
      ...(remapped
        ? {
            keybindings: {
              'terminal.copySelection': ['Ctrl+Shift+C'],
              'terminal.selectAll': ['Ctrl+Shift+A'],
              'terminal.paste': ['Ctrl+Shift+V']
            }
          }
        : {})
    })
    await pressShortcut(orcaPage, 'x', { shift: true })
    await expectCopyCursorReady(orcaPage)
    const tabId = await resolveActiveTabId(orcaPage)
    await orcaPage.evaluate(async (tabId) => {
      const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
      if (!pane) {
        throw new Error('No live terminal')
      }
      await new Promise<void>((resolve) =>
        pane.terminal.write('\x1b[2J\x1b[3J\x1b[HHIDDEN_LIVE', resolve)
      )
      pane.terminal.select(0, 0, 11)
    }, tabId)
    await orcaPage.keyboard.press('v')
    await orcaPage.keyboard.press('l')
    await orcaPage.keyboard.press('l')
    await orcaPage.keyboard.press(`${modifier}+c`)
    await expect.poll(() => copiedModeText(electronApp)).toBe('FRO')
    await orcaPage.keyboard.press(`${modifier}+a`)
    await orcaPage.keyboard.press(`${modifier}+c`)
    await expect
      .poll(async () => (await copiedModeText(electronApp))?.trim())
      .toBe('FROZEN_ALPHA\nsecond line')
    await orcaPage.keyboard.press(`${modifier}+v`)
    await expect(orcaPage.locator('.terminal-copy-mode [role="status"]')).toHaveText(
      'Copy mode · Selecting'
    )
    await orcaPage.keyboard.press('q')
    await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
    expect(await readTerminalPtyWrites(electronApp)).toEqual([])
    await expectHiddenCopyModeWindow(electronApp)
  })
}

test('copy mode does not claim menu actions from a focused palette textbox', async ({
  orcaPage,
  electronApp
}) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('clipboard:readText')
    ipcMain.handle('clipboard:readText', () => 'palette query')
  })
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Search worktrees and browser tabs' }).click()
  const input = orcaPage.getByRole('combobox')
  await input.fill('')
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('ui:appMenuPaste')
    }
  })
  await expect(input).toHaveValue('palette query')
  await dispatchMenuSelection(electronApp, 'select-all')
  await expect
    .poll(() =>
      input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])
    )
    .toEqual([0, 'palette query'.length])
  await orcaPage.keyboard.type('replacement')
  await expect(input).toHaveValue('replacement')
  expect(await readTerminalPtyWrites(electronApp)).toEqual([])
  await orcaPage.keyboard.press('Escape')
  await orcaPage.locator('.terminal-copy-mode .xterm-screen').click()
  await expectCopyCursorReady(orcaPage)
  await orcaPage.keyboard.press('q')
  await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
})

for (const exitOnCopy of [false, true]) {
  test(`menu copy preserves mouse-selected text through clipboard retry (exitOnCopy: ${exitOnCopy})`, async ({
    orcaPage,
    electronApp
  }) => {
    if (!exitOnCopy) {
      await configureCopyMode(orcaPage, { copyMode: { exitOnCopy: false } })
    }
    await pressShortcut(orcaPage, 'x', { shift: true })
    await expectCopyCursorReady(orcaPage)
    const mode = orcaPage.locator('.terminal-copy-mode')
    const screen = await mode.locator('.xterm-screen').boundingBox()
    const cell = await mode.locator('.terminal-copy-mode-cursor').evaluate((element) => ({
      width: Number.parseFloat(element.style.width),
      height: Number.parseFloat(element.style.height)
    }))
    if (!screen) {
      throw new Error('No frozen terminal screen for mouse selection')
    }
    const clip = { x: screen.x, y: screen.y, width: cell.width * 6, height: cell.height }
    const unselected = PNG.sync.read(await orcaPage.screenshot({ clip })).data
    await orcaPage.mouse.move(screen.x + cell.width * 0.1, screen.y + cell.height * 0.5)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(screen.x + cell.width * 5.9, screen.y + cell.height * 0.5, {
      steps: 12
    })
    await orcaPage.mouse.up()
    await expect
      .poll(async () => PNG.sync.read(await orcaPage.screenshot({ clip })).data.equals(unselected))
      .toBe(false)
    await expect(mode.locator('[role="status"]')).toHaveText('Copy mode')
    await electronApp.evaluate(() => {
      process.env.ORCA_E2E_COPY_MODE_FAIL = '1'
    })
    await dispatchMenuSelection(electronApp, 'copy')
    await expect(orcaPage.getByText('Could not copy terminal selection. Try again.')).toBeVisible()
    await expect(mode).toBeVisible()
    await electronApp.evaluate(() => {
      delete process.env.ORCA_E2E_COPY_MODE_FAIL
    })
    await dispatchMenuSelection(electronApp, 'copy')
    await expect.poll(() => copiedModeText(electronApp)).toBe('FROZEN')
    await (exitOnCopy ? expect(mode).toHaveCount(0) : expect(mode).toBeVisible())
    expect(await readTerminalPtyWrites(electronApp)).toEqual([])
    await expectHiddenCopyModeWindow(electronApp)
  })
}

test('menu copy retains a failed selection for retry and honors exitOnCopy', async ({
  orcaPage,
  electronApp
}) => {
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await orcaPage.keyboard.press('v')
  await orcaPage.keyboard.press('l')
  await electronApp.evaluate(() => {
    process.env.ORCA_E2E_COPY_MODE_FAIL = '1'
  })
  await dispatchMenuSelection(electronApp, 'copy')
  await expect(orcaPage.getByText('Could not copy terminal selection. Try again.')).toBeVisible()
  await expect(orcaPage.locator('.terminal-copy-mode [role="status"]')).toHaveText(
    'Copy mode · Selecting'
  )
  await electronApp.evaluate(() => {
    delete process.env.ORCA_E2E_COPY_MODE_FAIL
  })
  await dispatchMenuSelection(electronApp, 'copy')
  await expect.poll(() => copiedModeText(electronApp)).toBe('FR')
  await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
  expect(await readTerminalPtyWrites(electronApp)).toEqual([])
})
