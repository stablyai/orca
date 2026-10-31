import { writeFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import {
  execInTerminal,
  resolveActiveTabId,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './terminal'
import { nodeTerminalCommand } from '../terminal-node-command'

export async function startCopyModeTerminalProbe(page: Page): Promise<void> {
  const ptyId = await waitForActivePanePtyId(page)
  const script = `
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.on('data', (data) => process.stdout.write(data))
    process.stdin.resume()
    process.stdout.write('ORCA_COPY_' + 'INPUT_READY\\r\\n')
  `
  await execInTerminal(page, ptyId, nodeTerminalCommand(['-e', script]))
  await waitForTerminalOutput(page, 'ORCA_COPY_INPUT_READY')
}

export async function seedCopyModeScreen(
  page: Page,
  text = 'COPY_MODE_ALPHA\r\nsecond line'
): Promise<void> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    throw new Error('No active terminal tab')
  }
  await page.evaluate(
    async ({ tabId, text }) => {
      const pane = window.__paneManagers?.get(tabId)?.getActivePane()
      if (!pane) {
        throw new Error('No active terminal pane')
      }
      pane.terminal.options.screenReaderMode = true
      await new Promise<void>((resolve) =>
        pane.terminal.write(`\x1b[?1049l\x1b[2J\x1b[3J\x1b[H${text}\x1b[1;1H`, resolve)
      )
      pane.terminal.focus()
    },
    { tabId, text }
  )
}

export async function configureCopyMode(
  page: Page,
  document: Record<string, unknown>
): Promise<void> {
  const snapshot = await page.evaluate(async () => {
    if (!window.api.keybindings) {
      throw new Error('No keybindings API')
    }
    return window.api.keybindings.ensureFile()
  })
  // The app fixture asserts this path belongs to its disposable HOME before use.
  writeFileSync(
    snapshot.path,
    `${JSON.stringify({ version: 1, keybindings: {}, ...document }, null, 2)}\n`
  )
  await page.evaluate(() => window.__store?.getState().reloadKeybindings())
}

export async function isolateCopyModeClipboard(app: ElectronApplication): Promise<void> {
  // Keep the real renderer-to-main IPC, substituting only system clipboard persistence.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('clipboard:writeTerminalText')
    ipcMain.handle('clipboard:writeTerminalText', (_event, text: string) => {
      if (process.env.ORCA_E2E_COPY_MODE_FAIL === '1') {
        throw new Error('Simulated clipboard failure')
      }
      process.env.ORCA_E2E_COPY_MODE_TEXT = text
    })
  })
}

export function copiedModeText(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(() => process.env.ORCA_E2E_COPY_MODE_TEXT ?? null)
}

export async function resetCopiedModeText(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    delete process.env.ORCA_E2E_COPY_MODE_TEXT
  })
}

export async function expectCopyCursorReady(page: Page): Promise<void> {
  const cursor = page.locator('.terminal-copy-mode-cursor')
  await expect(cursor).toBeVisible()
  await expect(cursor).toHaveCSS('position', 'absolute')
  await expect(cursor).toBeInViewport()
  await expect
    .poll(() => cursor.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(0)
  await expect
    .poll(() =>
      cursor.evaluate((element) => {
        const viewport = element.closest('.terminal-copy-mode-viewport')
        const screen = element.parentElement
        return (
          viewport &&
          screen &&
          screen.clientWidth <= viewport.clientWidth &&
          screen.clientHeight <= viewport.clientHeight
        )
      })
    )
    .toBe(true)
  await expect
    .poll(() =>
      page
        .locator('.terminal-copy-mode .xterm-helper-textarea')
        .evaluate((element) => element.ownerDocument.activeElement === element)
    )
    .toBe(true)
}

export function copyCursorPosition(page: Page): Promise<{ x: number; y: number; width: number }> {
  return page.locator('.terminal-copy-mode-cursor').evaluate((element) => ({
    x: Number.parseFloat(element.style.left),
    y: Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width)
  }))
}

export async function pressCopyMotion(page: Page, keys: string): Promise<void> {
  for (const key of keys.split(' ')) {
    await page.keyboard.press(/^[A-Z]$/.test(key) ? `Shift+${key}` : key)
  }
}

export async function readCopyModeGridGeometry(page: Page) {
  await expect(page.locator('.terminal-copy-mode .xterm-accessibility-tree')).toContainText(/[!-~]/)
  return page.locator('.terminal-copy-mode').evaluate((root) => {
    const screen = root.querySelector<HTMLElement>('.xterm-screen')
    const rows = root.querySelector<HTMLElement>('.xterm-accessibility-tree')
    const cursor = root.querySelector<HTMLElement>('.terminal-copy-mode-cursor')
    const ascii = Array.from(rows?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? []).find(
      (row) => /^[\x20-\x7e]+$/.test(row.textContent ?? '')
    )
    if (!screen || !rows || !cursor || !ascii?.textContent) {
      throw new Error('Copy-mode grid has no measurable ASCII cell')
    }
    const cellWidth = ascii.getBoundingClientRect().width / ascii.textContent.length
    const rowCount = rows.childElementCount
    const cellHeight = Number.parseFloat(ascii.style.height)
    return {
      cols: Math.round(screen.clientWidth / cellWidth),
      rows: rowCount,
      cursor: {
        row: Math.round(Number.parseFloat(cursor.style.top) / cellHeight),
        column: Math.round(Number.parseFloat(cursor.style.left) / cellWidth)
      }
    }
  })
}

export async function expectCopyCursorCell(page: Page, row: number, column: number): Promise<void> {
  await expect
    .poll(async () => (await readCopyModeGridGeometry(page)).cursor)
    .toEqual({ row, column })
}

export async function expectHiddenCopyModeWindow(app: ElectronApplication): Promise<void> {
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
}
