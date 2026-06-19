/* eslint-disable max-lines -- Terminal shortcut E2E keeps platform keyboard paths beside their shared PTY assertions. */
/**
 * E2E test for terminal keyboard shortcuts.
 *
 * Verifies every chord resolved by resolveTerminalShortcutAction end-to-end:
 * real DOM keydown → window capture handler → policy → transport → IPC.
 *
 * sendInput chords are verified by intercepting pty:write in the Electron main
 * process so the test proves the bytes actually leave the renderer, without
 * depending on the shell's readline behaving identically across OSes. Action
 * chords (split, close, search, clear) are verified via their user-visible
 * side effect (pane count, search overlay, terminal buffer).
 *
 * Platform-specific chords (Cmd+Arrow, Cmd+Backspace on macOS only) are
 * skipped on the other platform since they'd never fire there at runtime.
 */

import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../src/shared/constants'
import {
  execInTerminal,
  countVisibleTerminalPanes,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent,
  waitForActivePanePtyId
} from './helpers/terminal'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'

// Why: contextBridge freezes window.api so the renderer cannot spy on
// pty.write directly. Intercept in the main process instead — pty:write is an
// ipcMain.on listener, so prepending a listener lets us capture every call
// without disturbing the real handler.
async function installMainProcessPtyWriteSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as {
      __ptyWriteLog?: { id: string; data: string }[]
      __ptyWriteSpyInstalled?: boolean
      __ptyWriteAcceptedSpyInstalled?: boolean
    }
    if (g.__ptyWriteSpyInstalled) {
      return
    }
    g.__ptyWriteLog = []
    g.__ptyWriteSpyInstalled = true
    ipcMain.prependListener('pty:write', (_event: unknown, args: { id: string; data: string }) => {
      g.__ptyWriteLog!.push({ id: args.id, data: args.data })
    })
    const invokeHandlers = (
      ipcMain as unknown as {
        _invokeHandlers?: Map<
          string,
          (event: unknown, args: { id: string; data: string }) => unknown
        >
      }
    )._invokeHandlers
    const writeAcceptedHandler = invokeHandlers?.get('pty:writeAccepted')
    if (writeAcceptedHandler && !g.__ptyWriteAcceptedSpyInstalled) {
      g.__ptyWriteAcceptedSpyInstalled = true
      invokeHandlers?.set('pty:writeAccepted', (event, args) => {
        g.__ptyWriteLog!.push({ id: args.id, data: args.data })
        return writeAcceptedHandler(event, args)
      })
    }
  })
}

async function clearPtyWriteLog(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as unknown as { __ptyWriteLog?: { id: string; data: string }[] }
    if (g.__ptyWriteLog) {
      g.__ptyWriteLog.length = 0
    }
  })
}

async function getPtyWrites(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __ptyWriteLog?: { id: string; data: string }[] }
    return (g.__ptyWriteLog ?? []).map((e) => e.data)
  })
}

// Why: the window-level keydown handler is gated on non-editable targets; the
// xterm helper textarea is treated as non-editable on purpose. Focusing it
// guarantees each chord reaches the shortcut policy through the real DOM path.
async function focusActiveTerminal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    textarea?.focus()
  })
}

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

async function focusFloatingTerminal(page: Page): Promise<void> {
  await page
    .locator(
      `[data-floating-terminal-panel][aria-hidden="false"] [data-terminal-tab-id] .xterm-helper-textarea`
    )
    .first()
    .focus()
}

async function seedFloatingTerminalTabSwitchScenario(page: Page): Promise<{
  backgroundFirstTabId: string
  floatingFirstTabId: string
  floatingSecondTabId: string
}> {
  return page.evaluate((floatingWorktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const backgroundWorktreeId = state.activeWorktreeId
    if (!backgroundWorktreeId) {
      throw new Error('No active background worktree')
    }

    const backgroundFirst =
      state.tabsByWorktree[backgroundWorktreeId]?.find(
        (tab) => tab.id === state.activeTabIdByWorktree[backgroundWorktreeId]
      ) ??
      state.tabsByWorktree[backgroundWorktreeId]?.find((tab) => tab.id === state.activeTabId) ??
      state.createTab(backgroundWorktreeId)
    state.createTab(backgroundWorktreeId)
    state.setActiveTab(backgroundFirst.id)
    state.setActiveTabType('terminal')

    const floatingFirst = state.createTab(floatingWorktreeId, undefined, undefined, {
      activate: false
    })
    state.activateTab(floatingFirst.id)
    const floatingGroupId =
      state.activeGroupIdByWorktree[floatingWorktreeId] ??
      state.groupsByWorktree[floatingWorktreeId]?.[0]?.id
    const floatingSecond = state.createTab(floatingWorktreeId, floatingGroupId, undefined, {
      activate: false
    })
    state.activateTab(floatingFirst.id)

    return {
      backgroundFirstTabId: backgroundFirst.id,
      floatingFirstTabId: floatingFirst.id,
      floatingSecondTabId: floatingSecond.id
    }
  }, FLOATING_TERMINAL_WORKTREE_ID)
}

async function getActiveFloatingTerminalTabId(page: Page): Promise<string | null> {
  return page.evaluate((floatingWorktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      return null
    }
    const groupId = state.activeGroupIdByWorktree[floatingWorktreeId]
    const group =
      (groupId
        ? state.groupsByWorktree[floatingWorktreeId]?.find((candidate) => candidate.id === groupId)
        : null) ??
      state.groupsByWorktree[floatingWorktreeId]?.find((candidate) => candidate.activeTabId) ??
      null
    const activeTab = group?.activeTabId
      ? state.unifiedTabsByWorktree[floatingWorktreeId]?.find((tab) => tab.id === group.activeTabId)
      : null
    return activeTab?.contentType === 'terminal' ? activeTab.entityId : null
  }, FLOATING_TERMINAL_WORKTREE_ID)
}

async function getActiveBackgroundTerminalTabId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return worktreeId ? (state.activeTabIdByWorktree[worktreeId] ?? state.activeTabId) : null
  })
}

async function enableKittyKeyboardReporting(page: Page, flags: number): Promise<void> {
  await page.evaluate(async (flags) => {
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
    if (!pane) {
      throw new Error('No active terminal pane for kitty keyboard setup')
    }
    await new Promise<void>((resolve) => {
      pane.terminal.write(`\x1b[=${flags}u`, resolve)
    })
  }, flags)
}

async function getKittyKeyboardFlags(page: Page): Promise<number | null> {
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

async function pressShiftedRussianLayoutKey(page: Page): Promise<{
  keydownDefaultPrevented: boolean
  keypressSent: boolean
  inputSent: boolean
  terminalInputSent: boolean
  keyupSent: boolean
}> {
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
    pane?.terminal.focus()
    const textarea = pane?.container.querySelector(
      '.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null
    if (!textarea) {
      throw new Error('No xterm helper textarea to receive keyboard input')
    }
    textarea.focus()

    const keydown = new KeyboardEvent('keydown', {
      key: 'Ф',
      code: 'KeyA',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keydown, 'keyCode', { get: () => 65 })
    Object.defineProperty(keydown, 'which', { get: () => 65 })
    textarea.dispatchEvent(keydown)

    if (keydown.defaultPrevented) {
      return {
        keydownDefaultPrevented: true,
        keypressSent: false,
        inputSent: false,
        terminalInputSent: false,
        keyupSent: false
      }
    }

    const keypress = new KeyboardEvent('keypress', {
      key: 'Ф',
      code: 'KeyA',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keypress, 'keyCode', { get: () => 1060 })
    Object.defineProperty(keypress, 'charCode', { get: () => 1060 })
    Object.defineProperty(keypress, 'which', { get: () => 1060 })
    textarea.dispatchEvent(keypress)

    const makeTextInputEvent = (): InputEvent => {
      const input = new InputEvent('input', {
        data: 'Ф',
        inputType: 'insertText',
        bubbles: true,
        cancelable: false,
        composed: false
      })
      // Why: older Linux Chromium builds can ignore InputEventInit fields on
      // synthetic events; xterm's input fallback reads these exact properties.
      Object.defineProperties(input, {
        data: { get: () => 'Ф' },
        inputType: { get: () => 'insertText' },
        composed: { get: () => false }
      })
      return input
    }

    // Why: Chromium on Linux can surface layout text through the `input` event
    // even when an untrusted synthetic keypress does not carry a usable charCode.
    const input = makeTextInputEvent()
    textarea.dispatchEvent(input)

    const keyup = new KeyboardEvent('keyup', {
      key: 'Ф',
      code: 'KeyA',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keyup, 'keyCode', { get: () => 65 })
    Object.defineProperty(keyup, 'which', { get: () => 65 })
    textarea.dispatchEvent(keyup)

    // Why: real Chromium feeds xterm through trusted text-input events, but
    // Linux CI drops the data path for untrusted synthetic InputEvents. xterm's
    // public input API exercises the same PTY data path without that browser
    // trust boundary, while the keydown assertion below still catches kitty
    // encoded sequences leaking from shifted layout keys.
    pane.terminal.input('Ф')

    return {
      keydownDefaultPrevented: false,
      keypressSent: true,
      inputSent: true,
      terminalInputSent: true,
      keyupSent: true
    }
  })
}

// Why: handleRequestClosePane pops a "Close Terminal?" dialog when the pane
// reports a running child process. Under E2E, a freshly split pane's
// proc.process is briefly unset so the check returns true spuriously. Click
// Close when the dialog appears so the test's chord-routing assertion stays
// deterministic; no-op when it doesn't.
async function confirmCloseDialogIfShown(page: Page): Promise<void> {
  const confirmButton = page.getByRole('button', { name: 'Close', exact: true })
  try {
    await confirmButton.waitFor({ state: 'visible', timeout: 500 })
    await confirmButton.click()
  } catch {
    // Dialog did not appear — pane closed directly.
  }
}

async function pressAndExpectWrite(
  page: Page,
  app: ElectronApplication,
  chord: string,
  expectedData: string
): Promise<void> {
  await clearPtyWriteLog(app)
  await focusActiveTerminal(page)
  await page.keyboard.press(chord)

  // Why: assert exact equality, not substring match. Short control codes like
  // \x01 (Ctrl+A) and \x05 (Ctrl+E) are single bytes that can appear inside
  // unrelated writes (shell prompt redraws, bracketed-paste sequences), so a
  // substring match would produce false positives.
  await expect
    .poll(async () => (await getPtyWrites(app)).some((w) => w === expectedData), {
      timeout: 5_000,
      message: `Expected chord "${chord}" to write ${JSON.stringify(expectedData)}`
    })
    .toBe(true)
}

const isMac = process.platform === 'darwin'
const mod = isMac ? 'Meta' : 'Control'

// Why: split chords differ by platform. On macOS Cmd+D splits vertically and
// Cmd+Shift+D horizontally. On Linux/Windows Ctrl+D is reserved for EOF
// (see terminal-shortcut-policy.ts and #586), so vertical is Ctrl+Shift+D
// and horizontal is Alt+Shift+D (Windows Terminal convention).
const splitVerticalChord = isMac ? `${mod}+d` : `${mod}+Shift+d`
const splitHorizontalChord = isMac ? `${mod}+Shift+d` : 'Alt+Shift+d'

// Why: serial mode is load-bearing. Tests mutate shared Electron app state
// (pane layout, terminal buffer, expand toggle) and the pty:write spy log is
// a single main-process singleton. Parallel execution would interleave chord
// effects and corrupt assertions.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Shortcuts', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager.'
    )
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  test('Shift+Enter writes the platform newline chord for terminal TUIs', async ({
    orcaPage,
    electronApp
  }) => {
    await installMainProcessPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(orcaPage)

    await pressAndExpectWrite(
      orcaPage,
      electronApp,
      'Shift+Enter',
      process.platform === 'win32' ? '\x1b\r' : '\x1b[13;2u'
    )
  })

  test('plain Ctrl+C sends ETX under kitty keyboard reporting', async ({
    orcaPage,
    electronApp
  }) => {
    await installMainProcessPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(orcaPage)
    await enableKittyKeyboardReporting(orcaPage, 31)
    await clearPtyWriteLog(electronApp)
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.down('Control')
    await orcaPage.keyboard.up('Control')
    expect((await getPtyWrites(electronApp)).join('')).toBe('')
    await clearPtyWriteLog(electronApp)

    expect(await dispatchCtrlCToActiveTerminalTextarea(orcaPage, { keyupCtrlKey: false })).toEqual({
      keydownDefaultPrevented: false,
      keyupDefaultPrevented: false
    })

    await expect
      .poll(async () => (await getPtyWrites(electronApp)).some((write) => write.includes('\x03')), {
        timeout: 5_000,
        message: 'Ctrl+C did not reach the PTY as ETX'
      })
      .toBe(true)
    const writes = (await getPtyWrites(electronApp)).join('')
    expect(writes).not.toContain('\x1b[99;5u')
    expect(writes).not.toContain('\x1b[99')

    await expect
      .poll(async () => await getKittyKeyboardFlags(orcaPage), {
        timeout: 5_000,
        message: 'Ctrl+C did not clear stale Kitty keyboard flags'
      })
      .toBe(0)

    await clearPtyWriteLog(electronApp)
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.type('x')
    await expect
      .poll(async () => (await getPtyWrites(electronApp)).some((write) => write === 'x'), {
        timeout: 5_000,
        message: 'Post-interrupt keyboard input stayed in Kitty CSI-u mode'
      })
      .toBe(true)
    const postInterruptWrites = (await getPtyWrites(electronApp)).join('')
    expect(postInterruptWrites).not.toContain('\x1b[')
    await orcaPage.keyboard.press('Backspace')
  })

  test('@headful Codex-like background output stays visible without disabling WebGL in auto mode', async ({
    orcaPage
  }) => {
    const hasPane = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      manager?.setTerminalGpuAcceleration('auto')
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      return Boolean(pane)
    })
    test.skip(!hasPane, 'No active terminal pane for renderer validation')
    const webglActive = await orcaPage
      .waitForFunction(
        () => {
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
          return Boolean(pane?.webglAddon)
        },
        null,
        { timeout: 5_000 }
      )
      .then(() => true)
      .catch(() => false)
    test.skip(!webglActive, 'WebGL was not active in this headful environment')

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `CODEX_BG_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `printf '\\033[48;2;52;52;52m  ${marker}  \\033[0m\\n'`)
    await waitForTerminalOutput(orcaPage, marker)

    await expect
      .poll(
        () =>
          orcaPage.evaluate((expectedMarker) => {
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
            const terminalText = pane?.terminal.buffer.active
              .translateBufferLineToString(pane.terminal.buffer.active.cursorY, true)
              .trim()
            const visibleText = pane?.container.textContent ?? ''
            return {
              markerVisible:
                visibleText.includes(expectedMarker) || terminalText === expectedMarker,
              hasComplexScriptOutput: pane?.hasComplexScriptOutput === true,
              hasWebgl: Boolean(pane?.webglAddon)
            }
          }, marker),
        {
          timeout: 5_000,
          message: 'Background SGR output did not stay visible on the auto renderer'
        }
      )
      .toEqual({
        markerVisible: true,
        hasComplexScriptOutput: false,
        hasWebgl: true
      })
  })

  test('floating terminal owns tab switch shortcuts while focused', async ({ orcaPage }) => {
    const scenario = await seedFloatingTerminalTabSwitchScenario(orcaPage)
    await orcaPage.evaluate(async () => {
      const state = window.__store?.getState()
      if (state?.settings?.floatingTerminalEnabled !== true) {
        await state?.updateSettings({ floatingTerminalEnabled: true })
      }
      if (!document.querySelector('[data-floating-terminal-panel][aria-hidden="false"]')) {
        window.dispatchEvent(new CustomEvent('orca-toggle-floating-terminal'))
      }
    })
    await expect(
      orcaPage.locator('[data-floating-terminal-panel][aria-hidden="false"]')
    ).toBeVisible()
    await focusFloatingTerminal(orcaPage)

    await orcaPage.keyboard.press(`${mod}+Shift+BracketRight`)
    await expect
      .poll(() => getActiveFloatingTerminalTabId(orcaPage), {
        timeout: 5_000,
        message: 'floating terminal did not switch to the next tab'
      })
      .toBe(scenario.floatingSecondTabId)
    await expect
      .poll(() => getActiveBackgroundTerminalTabId(orcaPage), {
        timeout: 1_000,
        message: 'background terminal tab changed while floating terminal was focused'
      })
      .toBe(scenario.backgroundFirstTabId)

    await focusFloatingTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+Shift+BracketLeft`)
    await expect
      .poll(() => getActiveFloatingTerminalTabId(orcaPage), {
        timeout: 5_000,
        message: 'floating terminal did not switch back to the previous tab'
      })
      .toBe(scenario.floatingFirstTabId)
    await expect(getActiveBackgroundTerminalTabId(orcaPage)).resolves.toBe(
      scenario.backgroundFirstTabId
    )
  })

  test('all terminal chords reach the PTY or fire their action', async ({
    orcaPage,
    electronApp
  }) => {
    await installMainProcessPtyWriteSpy(electronApp)

    // Seed the buffer so Cmd+K has something to clear.
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `SHORTCUT_TEST_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(orcaPage, marker)

    // --- send-input chords (platform-agnostic) ---

    // Alt+←/→ → readline backward-word / forward-word (\eb / \ef).
    await pressAndExpectWrite(orcaPage, electronApp, 'Alt+ArrowLeft', '\x1bb')
    await pressAndExpectWrite(orcaPage, electronApp, 'Alt+ArrowRight', '\x1bf')

    // Ctrl+←/→ on non-mac → readline backward-word / forward-word (\eb / \ef).
    // Mac-gated: Ctrl+Arrow on macOS is reserved for Mission Control / Spaces.
    if (!isMac) {
      await pressAndExpectWrite(orcaPage, electronApp, 'Control+ArrowLeft', '\x1bb')
      await pressAndExpectWrite(orcaPage, electronApp, 'Control+ArrowRight', '\x1bf')
    }

    // Alt+Backspace → Esc+DEL (readline backward-kill-word).
    await pressAndExpectWrite(orcaPage, electronApp, 'Alt+Backspace', '\x1b\x7f')

    // Ctrl+Backspace → \x17 (unix-word-rubout).
    await pressAndExpectWrite(orcaPage, electronApp, 'Control+Backspace', '\x17')

    // Shift+Enter → a modified Enter byte path so agents can distinguish it
    // from plain Enter. Windows uses Esc+CR because Codex ignores CSI-u there.
    await pressAndExpectWrite(
      orcaPage,
      electronApp,
      'Shift+Enter',
      process.platform === 'win32' ? '\x1b\r' : '\x1b[13;2u'
    )

    // --- send-input chords (macOS-only) ---

    if (isMac) {
      // Cmd+←/→ → Ctrl+A / Ctrl+E (beginning/end of line).
      await pressAndExpectWrite(orcaPage, electronApp, 'Meta+ArrowLeft', '\x01')
      await pressAndExpectWrite(orcaPage, electronApp, 'Meta+ArrowRight', '\x05')

      // Cmd+Backspace → Ctrl+U (kill line). Cmd+Delete → Ctrl+K (kill to EOL).
      await pressAndExpectWrite(orcaPage, electronApp, 'Meta+Backspace', '\x15')
      await pressAndExpectWrite(orcaPage, electronApp, 'Meta+Delete', '\x0b')
    }

    // --- action chords (no PTY byte; assert via visible effect) ---

    // Cmd/Ctrl+K clears the pane.
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+k`)
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), {
        timeout: 5_000,
        message: 'Cmd+K did not clear the terminal buffer'
      })
      .toBe(false)

    // Split vertically (chord varies by platform — see splitVerticalChord).
    const panesBeforeSplit = await countVisibleTerminalPanes(orcaPage)
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(splitVerticalChord)
    await waitForPaneCount(orcaPage, panesBeforeSplit + 1)

    // Cmd/Ctrl+] and Cmd/Ctrl+[ cycle focus (no pane-count change).
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+BracketRight`)
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+BracketLeft`)
    expect(await countVisibleTerminalPanes(orcaPage)).toBe(panesBeforeSplit + 1)

    // Cmd/Ctrl+Shift+Enter toggles expand on the active pane. Requires >1 pane,
    // so it runs while the vertical split from above is still open.
    const readExpanded = async (): Promise<boolean> =>
      orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        const tabId = state?.activeTabId
        if (!state || !tabId) {
          return false
        }
        return state.expandedPaneByTabId[tabId] === true
      })
    expect(await readExpanded()).toBe(false)
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+Shift+Enter`)
    await expect
      .poll(readExpanded, { timeout: 3_000, message: 'Cmd+Shift+Enter did not expand pane' })
      .toBe(true)
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+Shift+Enter`)
    await expect
      .poll(readExpanded, { timeout: 3_000, message: 'Cmd+Shift+Enter did not collapse pane' })
      .toBe(false)

    // Cmd/Ctrl+W closes the active split pane (not the whole tab: >1 pane).
    // Why: the close handler checks hasChildProcesses async; a freshly
    // spawned pane can transiently report a running child (node-pty's
    // proc.process lags the spawn), which surfaces a confirmation dialog
    // instead of closing immediately. Confirm it if it appears — the test
    // only needs to prove the chord routed to the close handler.
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+w`)
    await confirmCloseDialogIfShown(orcaPage)
    await waitForPaneCount(orcaPage, panesBeforeSplit)

    // Split horizontally (chord varies by platform — see splitHorizontalChord).
    const panesBeforeHSplit = await countVisibleTerminalPanes(orcaPage)
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(splitHorizontalChord)
    await waitForPaneCount(orcaPage, panesBeforeHSplit + 1)
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+w`)
    await confirmCloseDialogIfShown(orcaPage)
    await waitForPaneCount(orcaPage, panesBeforeHSplit)

    // Cmd/Ctrl+F toggles the search overlay.
    await focusActiveTerminal(orcaPage)
    await orcaPage.keyboard.press(`${mod}+f`)
    const searchInput = orcaPage.locator('[data-terminal-search-root] input').first()
    // Why: Escape is handled by TerminalSearch's React onKeyDown, which only
    // fires when focus is inside the overlay. The overlay auto-focuses its
    // input via a useEffect, but Playwright can press Escape before that
    // effect runs and the keystroke goes to the xterm textarea instead.
    // Wait for the input to actually be focused before pressing Escape.
    await expect(searchInput).toBeFocused({ timeout: 3_000 })
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.locator('[data-terminal-search-root]').first()).toBeHidden({
      timeout: 3_000
    })
  })

  test('Shift with Russian layout text reaches the PTY as Cyrillic under kitty keyboard reporting', async ({
    orcaPage,
    electronApp
  }) => {
    await installMainProcessPtyWriteSpy(electronApp)
    // Why: CI can mount the xterm surface before the pane transport has a
    // live PTY. Probe first so xterm onData cannot race a disconnected
    // sendInput path, then clear the probe writes before the layout assertion.
    await waitForActivePanePtyId(orcaPage)
    await enableKittyKeyboardReporting(orcaPage, 31)
    await clearPtyWriteLog(electronApp)

    const dispatch = await pressShiftedRussianLayoutKey(orcaPage)

    expect(dispatch).toEqual({
      keydownDefaultPrevented: false,
      keypressSent: true,
      inputSent: true,
      terminalInputSent: true,
      keyupSent: true
    })
    await expect
      .poll(async () => (await getPtyWrites(electronApp)).some((write) => write.includes('Ф')), {
        timeout: 5_000,
        message: 'Shift+Russian layout text did not reach the PTY as Cyrillic'
      })
      .toBe(true)
    const writes = await getPtyWrites(electronApp)
    const joinedWrites = writes.join('')
    expect(joinedWrites).not.toContain('\x1b[97:1060;2;1060u')
    expect(joinedWrites).not.toContain('\x1b[97:1060;2:3u')
  })
})
