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
import {
  discoverActivePtyId,
  execInTerminal,
  countVisibleTerminalPanes,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent
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
    }
    if (g.__ptyWriteSpyInstalled) {
      return
    }
    g.__ptyWriteLog = []
    g.__ptyWriteSpyInstalled = true
    ipcMain.prependListener('pty:write', (_event: unknown, args: { id: string; data: string }) => {
      g.__ptyWriteLog!.push({ id: args.id, data: args.data })
    })
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

  test('all terminal chords reach the PTY or fire their action', async ({
    orcaPage,
    electronApp
  }) => {
    await installMainProcessPtyWriteSpy(electronApp)

    // Seed the buffer so Cmd+K has something to clear.
    const ptyId = await discoverActivePtyId(orcaPage)
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

    // Shift+Enter → CSI-u so agents can distinguish from plain Enter.
    await pressAndExpectWrite(orcaPage, electronApp, 'Shift+Enter', '\x1b[13;2u')

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
})
