// Drive DOM keydown→capture→policy→transport→IPC for every terminal chord.
// Intercept main pty:write for exact bytes without OS-specific readline; assert action effects through panes/search/buffer.
// Skip platform-only chords where runtime policy would never emit them.

import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import '../../../../src/shared/workspace/identity/floating-workspace-id'
import { waitForActivePanePtyId, focusActiveTerminalInput } from './terminal'
import { waitForActiveTerminalManager, waitForPaneCount } from '../layout/terminal-pane-operations'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  ensureTerminalVisible
} from '../../desktop/renderer-probes/store'
import {
  clearTerminalPtyWriteLog as clearPtyWriteLog,
  installTerminalPtyWriteSpy as installMainProcessPtyWriteSpy,
  readTerminalPtyWrites as getPtyWrites
} from './terminal-pty-write-spy'
import './terminal-kitty-keyboard'

async function setActivePaneForegroundAgent(
  page: Page,
  agent: 'droid' | 'antigravity' | null
): Promise<string> {
  return page.evaluate((agent) => {
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
    if (!state || !tabId || !pane) {
      throw new Error('No active terminal pane for foreground-agent setup')
    }
    const paneKey = `${tabId}:${pane.leafId}`
    state.setPaneForegroundAgent(paneKey, {
      agent,
      shellForeground: false,
      // The shortcut only emits CSI-u for a process identity confirmed to
      // belong to this PTY; keep the fixture aligned with that trust gate.
      routingTrusted: agent === 'droid'
    })
    return paneKey
  }, agent)
}

async function pressAndExpectWrite(
  page: Page,
  app: ElectronApplication,
  chord: string,
  expectedData: string,
  repetitions = 1
): Promise<void> {
  await clearPtyWriteLog(app)
  await focusActiveTerminalInput(page)
  for (let index = 0; index < repetitions; index++) {
    await page.keyboard.press(chord)
  }

  // Match exact bytes: single control codes can occur inside unrelated prompt/paste writes.
  await expect
    .poll(async () => (await getPtyWrites(app)).filter((write) => write === expectedData).length, {
      timeout: 5_000,
      message: `Expected chord "${chord}" to write ${JSON.stringify(expectedData)}`
    })
    .toBeGreaterThanOrEqual(repetitions)
}

// Serialize shared layout/buffer/expand state and the singleton main pty:write spy to prevent interleaved chord effects.
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

  test('Droid gets CSI-u Shift+Enter on Windows without changing Antigravity', async ({
    orcaPage,
    electronApp
  }) => {
    test.skip(process.platform !== 'win32', 'Windows ConPTY encoding contract')
    await installMainProcessPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(orcaPage)
    const paneKey = await setActivePaneForegroundAgent(orcaPage, 'droid')
    try {
      await pressAndExpectWrite(orcaPage, electronApp, 'Shift+Enter', '\x1b[13;2u', 2)
      await setActivePaneForegroundAgent(orcaPage, 'antigravity')
      await pressAndExpectWrite(orcaPage, electronApp, 'Shift+Enter', '\x1b\r')
    } finally {
      await orcaPage.evaluate(
        (key) => window.__store?.getState().clearPaneForegroundAgent(key),
        paneKey
      )
    }
  })

  test('Windows forwards genuine Ctrl+Alt text chords to the PTY', async ({
    orcaPage,
    electronApp
  }) => {
    test.skip(process.platform !== 'win32', 'Windows xterm AltGr classification regression')
    await installMainProcessPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(orcaPage)

    await pressAndExpectWrite(orcaPage, electronApp, 'Control+Alt+u', '\x1b\x15')
    await pressAndExpectWrite(orcaPage, electronApp, 'Control+Alt+2', '\x1b2')
    await pressAndExpectWrite(orcaPage, electronApp, 'Control+Alt+;', '\x1b;')
  })

  test('Ctrl+Enter protects local ConPTY shells without breaking trusted TUI chords', async ({
    orcaPage,
    electronApp
  }) => {
    await installMainProcessPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(orcaPage)

    if (process.platform === 'win32') {
      await pressAndExpectWrite(orcaPage, electronApp, 'Control+Enter', '\r')
      const paneKey = await setActivePaneForegroundAgent(orcaPage, 'droid')
      try {
        // Droid queries CSI-u without activating live flags; trusted process evidence preserves cue/queue.
        await pressAndExpectWrite(orcaPage, electronApp, 'Control+Enter', '\x1b[13;5u')
      } finally {
        await orcaPage.evaluate(
          (key) => window.__store?.getState().clearPaneForegroundAgent(key),
          paneKey
        )
      }
      return
    }

    // Preserve the established query-only Droid/Grok contract outside local ConPTY.
    await pressAndExpectWrite(orcaPage, electronApp, 'Control+Enter', '\x1b[13;5u')
  })
})
