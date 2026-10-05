import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { execInTerminal, focusActiveTerminalInput } from './terminal'
import { clearTerminalPtyWriteLog, readTerminalPtyWrites } from './terminal-pty-write-spy'

async function dispatchCtrlCToActiveTerminalTextarea(
  page: Page,
  options: { keyupCtrlKey?: boolean } = {}
): Promise<{
  keydownDefaultPrevented: boolean
  keyupDefaultPrevented: boolean
}> {
  return page.evaluate((dispatchOptions) => {
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
    const textarea = pane?.container.querySelector(
      '.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null
    if (!pane || !textarea) {
      throw new Error('No active terminal textarea for Ctrl+C dispatch')
    }
    pane.terminal.clearSelection()
    pane.terminal.focus()
    textarea.focus()

    const createEvent = (type: 'keydown' | 'keyup', ctrlKey: boolean): KeyboardEvent => {
      const event = new KeyboardEvent(type, {
        key: 'c',
        code: 'KeyC',
        ctrlKey,
        bubbles: true,
        cancelable: true
      })
      Object.defineProperty(event, 'keyCode', { get: () => 67 })
      Object.defineProperty(event, 'which', { get: () => 67 })
      return event
    }

    // Why: Electron headless consumes real Ctrl+C before xterm in automation;
    // synthetic DOM events still exercise Orca's installed xterm boundary.
    const keydown = createEvent('keydown', true)
    textarea.dispatchEvent(keydown)
    const keyup = createEvent('keyup', dispatchOptions.keyupCtrlKey !== false)
    textarea.dispatchEvent(keyup)
    return {
      keydownDefaultPrevented: keydown.defaultPrevented,
      keyupDefaultPrevented: keyup.defaultPrevented
    }
  }, options)
}

export async function getKittyKeyboardFlags(page: Page): Promise<number | null> {
  return page.evaluate(() => {
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
    const terminal = pane?.terminal as
      | {
          core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
          _core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
        }
      | undefined
    return (
      terminal?.core?.coreService?.kittyKeyboard?.flags ??
      terminal?._core?.coreService?.kittyKeyboard?.flags ??
      null
    )
  })
}

// Why arm from the PTY: the mirror the shortcut policy reads only sees application output.
export async function armKittyKeyboardFromPty(
  page: Page,
  ptyId: string,
  command: string
): Promise<void> {
  await execInTerminal(page, ptyId, command)
  await expect
    .poll(async () => await getKittyKeyboardFlags(page), {
      timeout: 15_000,
      message: 'the application never armed kitty keyboard reporting'
    })
    .toBe(31)
}

export async function interruptAndExpectEtx(page: Page, app: ElectronApplication): Promise<void> {
  await clearTerminalPtyWriteLog(app)
  await focusActiveTerminalInput(page)
  await page.keyboard.down('Control')
  await page.keyboard.up('Control')
  expect((await readTerminalPtyWrites(app)).join('')).toBe('')
  await clearTerminalPtyWriteLog(app)

  expect(await dispatchCtrlCToActiveTerminalTextarea(page, { keyupCtrlKey: false })).toEqual({
    keydownDefaultPrevented: false,
    keyupDefaultPrevented: false
  })
  await expect
    .poll(async () => (await readTerminalPtyWrites(app)).some((write) => write.includes('\x03')), {
      timeout: 5_000,
      message: 'Ctrl+C did not reach the PTY as ETX'
    })
    .toBe(true)
  const writes = (await readTerminalPtyWrites(app)).join('')
  expect(writes).not.toContain('\x1b[99;5u')
  expect(writes).not.toContain('\x1b[99')
}
