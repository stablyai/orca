import { writeFileSync } from 'node:fs'
import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import { retryTransientMainEvaluate } from './electron-main-evaluate-retry'
import { waitForActivePanePtyId } from '../../terminal/input/terminal'
import { resolveActiveTabId } from '../../terminal/layout/terminal-pane-identity'
import {
  execInTerminal,
  waitForTerminalOutput
} from '../../terminal/layout/terminal-pane-operations'
import { nodeTerminalCommand } from '../../terminal/input/terminal-node-command'

type PtyWriteLogEntry = { id: string; data: string }

declare global {
  var __terminalPtyWriteLog: PtyWriteLogEntry[] | undefined
  var __terminalPtyWriteSpyInstalled: boolean | undefined
  var __terminalPtyWriteAcceptedSpyInstalled: boolean | undefined
}

const modifierKeyByPage = new WeakMap<Page, 'Meta' | 'Control'>()

async function getModifierKey(page: Page): Promise<'Meta' | 'Control'> {
  const cached = modifierKeyByPage.get(page)
  if (cached) {
    return cached
  }
  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  const modifierKey = isMac ? 'Meta' : 'Control'
  modifierKeyByPage.set(page, modifierKey)
  return modifierKey
}

export async function pressShortcut(
  page: Page,
  key: string,
  options: { shift?: boolean } = {}
): Promise<void> {
  const parts: string[] = [await getModifierKey(page)]
  if (options.shift) {
    parts.push('Shift')
  }
  parts.push(key)
  await page.keyboard.press(parts.join('+'))
}

export async function installTerminalPtyWriteSpy(app: ElectronApplication): Promise<void> {
  await retryTransientMainEvaluate(() =>
    app.evaluate(({ ipcMain }) => {
      if (globalThis.__terminalPtyWriteSpyInstalled) {
        return
      }
      const log: PtyWriteLogEntry[] = []
      globalThis.__terminalPtyWriteLog = log
      globalThis.__terminalPtyWriteSpyInstalled = true
      ipcMain.prependListener('pty:write', (_event: unknown, args: PtyWriteLogEntry) => {
        log.push({ id: args.id, data: args.data })
      })

      // Playwright cannot observe ipcRenderer.invoke payloads, so this e2e spy wraps main's handler.
      if (
        !('_invokeHandlers' in ipcMain) ||
        !(ipcMain._invokeHandlers instanceof Map) ||
        globalThis.__terminalPtyWriteAcceptedSpyInstalled
      ) {
        return
      }
      const writeAcceptedHandler: unknown = ipcMain._invokeHandlers.get('pty:writeAccepted')
      if (typeof writeAcceptedHandler !== 'function') {
        return
      }
      globalThis.__terminalPtyWriteAcceptedSpyInstalled = true
      ipcMain._invokeHandlers.set(
        'pty:writeAccepted',
        async (event: unknown, args: PtyWriteLogEntry) => {
          log.push({ id: args.id, data: args.data })
          return writeAcceptedHandler(event, args)
        }
      )
    })
  )
}

export async function clearTerminalPtyWriteLog(app: ElectronApplication): Promise<void> {
  await retryTransientMainEvaluate(() =>
    app.evaluate(() => {
      if (globalThis.__terminalPtyWriteLog) {
        globalThis.__terminalPtyWriteLog.length = 0
      }
    })
  )
}

export async function readTerminalPtyWrites(app: ElectronApplication): Promise<string[]> {
  return retryTransientMainEvaluate(() =>
    app.evaluate(() => (globalThis.__terminalPtyWriteLog ?? []).map((entry) => entry.data))
  )
}

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
