/**
 * E2E for issue #14024: on a macOS layout that composes printable ASCII with
 * Option (Turkish Q: Option+Q → `@`, Option+4 → `$`), a kitty-keyboard TUI must
 * receive the composed character, not the physical Alt chord.
 *
 * The regression only exists once the pane's application has negotiated the
 * kitty keyboard protocol, so the kitty flags are armed the way a real TUI arms
 * them — by emitting `CSI > 1 u` from the PTY — rather than by poking renderer
 * state. Bytes are asserted at the main-process `pty:write` boundary so the test
 * proves what actually leaves the renderer.
 */

import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForActivePanePtyId
} from './helpers/terminal'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  clearTerminalPtyWriteLog as clearPtyWriteLog,
  installTerminalPtyWriteSpy as installMainProcessPtyWriteSpy,
  readTerminalPtyWrites as getPtyWrites
} from './helpers/terminal-pty-write-spy'

type MacOptionAsAltSetting = 'auto' | 'true' | 'false' | 'left' | 'right'

async function setMacOptionAsAlt(page: Page, value: MacOptionAsAltSetting): Promise<void> {
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
async function pressOptionComposedKey(
  page: Page,
  press: { key: string; code: string; shiftKey?: boolean }
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
    const textarea = pane?.container.querySelector(
      '.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null
    if (!pane || !textarea) {
      throw new Error('No active terminal textarea for the Option chord dispatch')
    }
    pane.terminal.focus()
    textarea.focus()

    // Why: the policy resolves left-vs-right Option from the modifier's own
    // keydown, so the chord has to be preceded by a real AltLeft press.
    const modifierInit = { key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true }
    const altDown = new KeyboardEvent('keydown', modifierInit)
    Object.defineProperty(altDown, 'location', { get: () => 1 })
    textarea.dispatchEvent(altDown)

    const keydown = new KeyboardEvent('keydown', {
      key: press.key,
      code: press.code,
      altKey: true,
      shiftKey: press.shiftKey === true,
      bubbles: true,
      cancelable: true
    })
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
    Object.defineProperty(altUp, 'location', { get: () => 1 })
    textarea.dispatchEvent(altUp)

    return { keydownDefaultPrevented: keydown.defaultPrevented }
  }, press)
}

async function armKittyKeyboardFromPty(page: Page, ptyId: string): Promise<void> {
  // Why: this is the byte a real kitty-protocol TUI pushes at startup; routing it
  // through the PTY exercises the same output-scanning mirror the policy reads.
  await execInTerminal(page, ptyId, `printf '\\033[>1u'`)
  await expect
    .poll(async () => getPaneKittyKeyboardFlags(page), {
      timeout: 15_000,
      message: 'the pane never mirrored the application kitty keyboard flags'
    })
    .toBeGreaterThan(0)
}

async function setUpPane(
  page: Page,
  app: ElectronApplication
): Promise<{ ptyId: string; joinedWrites: () => Promise<string> }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  await installMainProcessPtyWriteSpy(app)
  await armKittyKeyboardFromPty(page, ptyId)
  return { ptyId, joinedWrites: async () => (await getPtyWrites(app)).join('') }
}

test.describe('Option-composed ASCII in a kitty-keyboard pane', () => {
  test.skip(process.platform !== 'darwin', 'Option composition is a macOS-only input path (#14024)')

  test('types the composed character instead of reporting the physical Alt chord', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpPane(orcaPage, electronApp)
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)

    // Turkish Q: the physical `q` key composes `@`.
    const dispatch = await pressOptionComposedKey(orcaPage, { key: '@', code: 'KeyQ' })
    expect(dispatch.keydownDefaultPrevented).toBe(true)

    await expect
      .poll(joinedWrites, {
        timeout: 5_000,
        message: 'Option-composed `@` never reached the PTY'
      })
      .toContain('@')
    // \x1b[113;3u is alt+q — the chord that swallowed the character in #14024.
    expect(await joinedWrites()).not.toContain('\x1b[113;3u')
  })

  test('types a composed character that also needs Shift', async ({ orcaPage, electronApp }) => {
    const { joinedWrites } = await setUpPane(orcaPage, electronApp)
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)

    // QWERTZ-class layouts put `\` on the shifted Option layer (Option+Shift+7),
    // where no other chord can reach it.
    const dispatch = await pressOptionComposedKey(orcaPage, {
      key: '\\',
      code: 'Digit7',
      shiftKey: true
    })
    expect(dispatch.keydownDefaultPrevented).toBe(true)

    await expect
      .poll(joinedWrites, {
        timeout: 5_000,
        message: 'Option+Shift-composed `\\` never reached the PTY'
      })
      .toContain('\\')
    expect(await joinedWrites()).not.toContain('\x1b[55;4u')
  })

  test('still reports the Alt chord when Option is configured as Alt', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpPane(orcaPage, electronApp)
    await setMacOptionAsAlt(orcaPage, 'true')
    await clearPtyWriteLog(electronApp)

    const dispatch = await pressOptionComposedKey(orcaPage, { key: '@', code: 'KeyQ' })
    expect(dispatch.keydownDefaultPrevented).toBe(true)

    await expect
      .poll(joinedWrites, {
        timeout: 5_000,
        message: 'configured Option-as-Alt did not report the physical alt+q chord'
      })
      .toContain('\x1b[113;3u')
    expect(await joinedWrites()).not.toContain('@')
  })

  test('keeps non-ASCII Option glyphs as TUI hotkeys', async ({ orcaPage, electronApp }) => {
    const { joinedWrites } = await setUpPane(orcaPage, electronApp)
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)

    // #8031: OMP-class TUIs bind Option+P, which composes the non-ASCII `π`.
    const dispatch = await pressOptionComposedKey(orcaPage, { key: 'π', code: 'KeyP' })
    expect(dispatch.keydownDefaultPrevented).toBe(true)

    await expect
      .poll(joinedWrites, {
        timeout: 5_000,
        message: 'Option+P did not reach the TUI as the alt+p hotkey'
      })
      .toContain('\x1b[112;3u')
    expect(await joinedWrites()).not.toContain('π')
  })
})
