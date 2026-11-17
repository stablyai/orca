// Drive DOM keydown→capture→policy→transport→IPC for every terminal chord.
// Intercept main pty:write for exact bytes without OS-specific readline; assert action effects through panes/search/buffer.
// Skip platform-only chords where runtime policy would never emit them.

import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../src/shared/workspace/identity/floating-workspace-id'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  waitForActivePanePtyId,
  focusActiveTerminalInput
} from './helpers/terminal'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  clearTerminalPtyWriteLog as clearPtyWriteLog,
  installTerminalPtyWriteSpy as installMainProcessPtyWriteSpy,
  readTerminalPtyWrites as getPtyWrites
} from './helpers/terminal-pty-write-spy'
import './helpers/terminal-kitty-keyboard'

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
    state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)

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

async function getActiveTerminalViewport(
  page: Page
): Promise<{ viewportY: number; baseY: number }> {
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
    const buffer = pane?.terminal.buffer.active
    if (!buffer) {
      throw new Error('No active terminal buffer')
    }
    return {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY
    }
  })
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

const isMac = process.platform === 'darwin'
const mod = isMac ? 'Meta' : 'Control'

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

  test('Cmd+Up/Down scrolls terminal viewport without writing to the PTY on macOS', async ({
    orcaPage,
    electronApp
  }) => {
    test.skip(!isMac, 'Cmd+Up/Down terminal scroll navigation is macOS-only')

    await installMainProcessPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `CMD_ARROW_SCROLL_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `for i in {1..120}; do echo ${marker}_$i; done`)
    await waitForTerminalOutput(orcaPage, `${marker}_120`)

    await expect
      .poll(
        async () => {
          const viewport = await getActiveTerminalViewport(orcaPage)
          return viewport.baseY > 0 && viewport.viewportY === viewport.baseY
        },
        {
          timeout: 5_000,
          message: 'terminal did not settle at the bottom with scrollback for Cmd+Up/Down repro'
        }
      )
      .toBe(true)

    await clearPtyWriteLog(electronApp)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press('Meta+ArrowUp')
    await expect
      .poll(async () => getActiveTerminalViewport(orcaPage), {
        timeout: 5_000,
        message: 'Cmd+Up did not scroll the terminal viewport to the top'
      })
      .toMatchObject({ viewportY: 0 })
    expect(await getPtyWrites(electronApp)).toEqual([])

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press('Meta+ArrowDown')
    await expect
      .poll(
        async () => {
          const viewport = await getActiveTerminalViewport(orcaPage)
          return viewport.viewportY === viewport.baseY
        },
        {
          timeout: 5_000,
          message: 'Cmd+Down did not scroll the terminal viewport to the bottom'
        }
      )
      .toBe(true)
    expect(await getPtyWrites(electronApp)).toEqual([])
  })
})
