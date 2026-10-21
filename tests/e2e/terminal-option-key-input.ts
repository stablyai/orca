import type { CDPSession, ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForActivePanePtyId
} from './helpers/terminal'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  installTerminalPtyWriteSpy as installMainProcessPtyWriteSpy,
  readTerminalPtyWrites as getPtyWrites
} from './helpers/terminal-pty-write-spy'
import type { KeyboardLayoutSnapshot } from '../../src/shared/keyboard-layout-snapshot'

type MacOptionAsAltSetting = 'auto' | 'true' | 'false' | 'left' | 'right'

export async function setMacOptionAsAlt(page: Page, value: MacOptionAsAltSetting): Promise<void> {
  await page.evaluate(async (value) => {
    await window.__store?.getState().updateSettings({ terminalMacOptionAsAlt: value })
  }, value)
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__store?.getState().settings?.terminalMacOptionAsAlt ?? null),
      { timeout: 5_000, message: 'terminalMacOptionAsAlt did not apply' }
    )
    .toBe(value)
}

/** Reads the pane's mirrored kitty flags — the exact value the policy consults. */
async function getPaneKittyKeyboardFlags(page: Page): Promise<number> {
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm exposes negotiated flags through either bundled core shape.
    const terminal = pane?.terminal as
      | {
          core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
          _core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
        }
      | undefined
    return (
      terminal?.core?.coreService?.kittyKeyboard?.flags ??
      terminal?._core?.coreService?.kittyKeyboard?.flags ??
      0
    )
  })
}

/**
 * Dispatches the keydown macOS delivers for an Option-composed key: `key` is
 * already the composed glyph while `code` still names the physical key.
 */
export async function pressOptionComposedKey(
  page: Page,
  press: { key: string; code: string; shiftKey?: boolean; side?: 'left' | 'right' }
): Promise<{ keydownDefaultPrevented: boolean }> {
  return page.evaluate((press) => {
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
    const textarea = pane?.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!pane || !textarea) {
      throw new Error('No active terminal textarea for the Option chord dispatch')
    }
    pane.terminal.focus()
    textarea.focus()

    // The side-specific setting reads the modifier's location before the chord.
    const location = press.side === 'right' ? 2 : 1
    const modifierInit = {
      key: 'Alt',
      code: location === 2 ? 'AltRight' : 'AltLeft',
      altKey: true,
      bubbles: true
    }
    const altDown = new KeyboardEvent('keydown', modifierInit)
    Object.defineProperty(altDown, 'location', { get: () => location })
    textarea.dispatchEvent(altDown)

    const keydown = new KeyboardEvent('keydown', {
      key: press.key,
      code: press.code,
      altKey: true,
      shiftKey: press.shiftKey === true,
      bubbles: true,
      cancelable: true
    })
    const keyCodes: Record<string, number> = { Semicolon: 186, Comma: 188, Period: 190 }
    const keyCode = keyCodes[press.code]
    if (keyCode) {
      Object.defineProperty(keydown, 'keyCode', { value: keyCode })
    }
    textarea.dispatchEvent(keydown)

    textarea.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: press.key,
        code: press.code,
        altKey: true,
        shiftKey: press.shiftKey === true,
        bubbles: true,
        cancelable: true
      })
    )
    const altUp = new KeyboardEvent('keyup', modifierInit)
    Object.defineProperty(altUp, 'location', { get: () => location })
    textarea.dispatchEvent(altUp)

    return { keydownDefaultPrevented: keydown.defaultPrevented }
  }, press)
}

async function armKittyKeyboardFromPty(page: Page, ptyId: string, flags: number): Promise<void> {
  // Why: this is the byte a real kitty-protocol TUI pushes at startup; routing it
  // through the PTY exercises the same output-scanning mirror the policy reads.
  // `cat` stays in the foreground: flags left armed at exit are grounded by the host.
  await execInTerminal(page, ptyId, `printf '\\033[>${flags}u'; cat`)
  await expect
    .poll(async () => getPaneKittyKeyboardFlags(page), {
      timeout: 15_000,
      message: 'the pane never mirrored the application kitty keyboard flags'
    })
    .toBe(flags)
}

export async function setUpOptionKeyboardPane(
  page: Page,
  app: ElectronApplication,
  kittyFlags = 1
): Promise<{ joinedWrites: () => Promise<string> }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  await installMainProcessPtyWriteSpy(app)
  await armKittyKeyboardFromPty(page, ptyId, kittyFlags)
  return { joinedWrites: async () => (await getPtyWrites(app)).join('') }
}

export async function publishMacKeyboardLayout(
  app: ElectronApplication,
  snapshot: KeyboardLayoutSnapshot | null,
  generation: number
): Promise<void> {
  await app.evaluate(
    ({ ipcMain, BrowserWindow }, { snapshot, generation }) => {
      ipcMain.removeHandler('app:getKeyboardLayoutSnapshot')
      ipcMain.handle('app:getKeyboardLayoutSnapshot', () => snapshot)
      ipcMain.removeHandler('app:getKeyboardInputSourceId')
      ipcMain.handle('app:getKeyboardInputSourceId', () => snapshot?.inputSourceId ?? null)
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('app:keyboardLayoutChanged', { phase: 'refresh', generation })
      }
    },
    { snapshot, generation }
  )
}

export async function waitForPaneOptionAsAlt(page: Page, expected: boolean): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__store?.getState()
        const tabId = state?.activeTabId
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        return pane?.terminal.options.macOptionIsMeta
      })
    )
    .toBe(expected)
}

export async function pressChromiumOptionPunctuation(
  cdp: CDPSession,
  key: { key: string; code: string; base: string; windowsVirtualKeyCode: number }
): Promise<void> {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: key.key,
    code: key.code,
    modifiers: 1,
    text: key.key,
    unmodifiedText: key.base,
    windowsVirtualKeyCode: key.windowsVirtualKeyCode
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: key.key,
    code: key.code,
    modifiers: 1,
    windowsVirtualKeyCode: key.windowsVirtualKeyCode
  })
}
