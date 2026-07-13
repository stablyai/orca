import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

type HiddenTuiWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string, meta?: { seq?: number; rawLength?: number }) => boolean
  }
  // Why: only the mode-2031 fact-reply counter survives Phase 6 — the
  // hidden-skip counters were deleted with the renderer skip grammar.
  __terminalPtyOutputDebug?: {
    reset: () => void
    snapshot: () => {
      hiddenRendererMode2031ReplyCount: number
    }
  }
}

type TuiCursorState = {
  hidden: boolean | null
  initialized: boolean | null
}

const HIDDEN_FRAME_SCRIPT_DELAY_MS = 750

function tuiFrame(runId: string, frame: number): string {
  const progress = `${'█'.repeat((frame % 8) + 1)}${'░'.repeat(8 - ((frame % 8) + 1))}`
  const rows = [
    '╭────────────────────────────────────────────────────────────────────╮',
    `│ OpenCode visual restore Frame ${String(frame).padStart(3, '0')} ${frame % 2 === 0 ? '🟢' : '🟡'} ${progress} │`,
    '├──────────────┬──────────────────────┬──────────────────────────────┤',
    `│ model        │ codex/opencode       │ ${runId.slice(0, 28).padEnd(28)} │`,
    `│ status       │ ${frame % 2 === 0 ? 'thinking' : 'streaming'}            │ input ${'#'.repeat((frame % 18) + 1).padEnd(22)} │`,
    `│ diff         │ +${String(frame * 3).padEnd(19)} │ -${String(frame).padEnd(27)} │`,
    '╰──────────────┴──────────────────────┴──────────────────────────────╯',
    `VISUAL_RESTORE_FINAL_${runId}_${frame}`
  ]
  return [
    '\x1b[?2026h',
    '\x1b[?1049h',
    '\x1b[2J\x1b[H',
    '\x1b[?25l',
    rows.map((row) => `\x1b[2;36m${row}\x1b[0m`).join('\r\n'),
    '\x1b[10;18H\x1b[?25h',
    '\x1b[?2026l'
  ].join('')
}

function lowRiskRestoreFrame(runId: string, frame: number): string {
  const rows = [
    `LOW_RISK_RESTORE_FRAME_${runId}_${frame}`,
    `status=${frame % 2 === 0 ? 'thinking' : 'streaming'}`,
    `progress=${String(frame).padStart(3, '0')}`,
    `VISUAL_RESTORE_FINAL_${runId}_${frame}`
  ]
  return `${rows.join('\r\n')}\r\n`
}

async function resetHiddenDebug(page: Page): Promise<void> {
  await page.evaluate(async () => {
    ;(window as HiddenTuiWindow).__terminalPtyOutputDebug?.reset()
    // Why: under the Phase-4 hidden-delivery gate the withheld-output signal
    // lives in main's delivery debug counters, not the renderer skip path.
    await window.api.pty.resetRendererDeliveryDebug()
  })
}

function writeHiddenFrameScript(scriptPath: string, runId: string): void {
  const frames = Array.from({ length: 25 }, (_, frame) => tuiFrame(runId, frame))
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(
    scriptPath,
    `setTimeout(() => process.stdout.write(${JSON.stringify(frames.join(''))}), ${HIDDEN_FRAME_SCRIPT_DELAY_MS})\n`
  )
}

function writeLowRiskFrameScript(scriptPath: string, frame: string): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(
    scriptPath,
    `setTimeout(() => process.stdout.write(${JSON.stringify(frame)}), ${HIDDEN_FRAME_SCRIPT_DELAY_MS})\n`
  )
}

async function writeHiddenFrames(page: Page, ptyId: string, scriptPath: string): Promise<void> {
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
}

// Why: Phase-4 hidden-delivery gate contract — hidden PTY bytes are dropped
// in main after model ingestion and never reach the renderer, so "hidden
// output was withheld" is observed via main's dropped-chars counter instead
// of the old renderer hidden-skip counters.
async function readMainHiddenDeliveryDroppedChars(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const snapshot = await window.api.pty.getRendererDeliveryDebugSnapshot()
    return snapshot.hiddenDeliveryDroppedChars
  })
}

async function readTuiCursorState(page: Page): Promise<TuiCursorState> {
  return page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
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
      throw new Error('Active terminal pane is unavailable')
    }
    const terminalCore = (
      pane.terminal as unknown as {
        _core?: { coreService?: { isCursorHidden?: boolean; isCursorInitialized?: boolean } }
      }
    )._core
    return {
      hidden: terminalCore?.coreService?.isCursorHidden ?? null,
      initialized: terminalCore?.coreService?.isCursorInitialized ?? null
    }
  })
}

async function injectPaneData(
  page: Page,
  paneKey: string,
  data: string,
  meta?: { seq?: number; rawLength?: number }
): Promise<void> {
  const injected = await page.evaluate(
    ({ paneKey, data, meta }) => {
      return (window as HiddenTuiWindow).__terminalPtyDataInjection?.inject(paneKey, data, meta)
    },
    { paneKey, data, meta }
  )
  if (!injected) {
    throw new Error(`No terminal PTY data injector registered for ${paneKey}`)
  }
}

async function readMainSnapshotSource(
  page: Page,
  ptyId: string
): Promise<'headless' | 'renderer' | null> {
  return page.evaluate(async (ptyId) => {
    const snapshot = await window.api.pty.getMainBufferSnapshot(ptyId, {
      scrollbackRows: 200
    })
    return snapshot?.source ?? null
  }, ptyId)
}

async function getUnreadTerminalTabIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }
    return Object.keys(store.getState().unreadTerminalTabs)
  })
}

async function getRuntimePaneTitle(
  page: Page,
  tabId: string,
  numericPaneId: number
): Promise<string | null> {
  return page.evaluate(
    ({ tabId, numericPaneId }) => {
      const store = window.__store
      if (!store) {
        return null
      }
      return store.getState().runtimePaneTitlesByTabId[tabId]?.[numericPaneId] ?? null
    },
    { tabId, numericPaneId }
  )
}

async function writeHiddenSideEffectBurst(
  page: Page,
  ptyId: string,
  title: string,
  marker: string
): Promise<void> {
  const payload = `\x07\x1b]0;${title}\x07${marker}\n`
  const script = `process.stdout.write(${JSON.stringify(payload)}); setTimeout(() => process.exit(0), 30000)`
  await sendToTerminal(page, ptyId, `node -e ${JSON.stringify(script)}\r`)
}

test.describe('Hidden terminal TUI visual restore', () => {
  test('restores hidden full-screen TUI output without visible corruption', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'hidden TUI restore needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const hiddenSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const hiddenPane = hiddenSnapshot.panes[0]
    if (!hiddenPane?.ptyId) {
      throw new Error('hidden visual restore pane did not bind a PTY')
    }
    await switchToWorktree(orcaPage, firstWorktreeId)
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), {
        timeout: 10_000,
        message: 'first worktree did not become active before hidden TUI injection'
      })
      .toBe(firstWorktreeId)

    const runId = randomUUID()
    const finalMarker = `VISUAL_RESTORE_FINAL_${runId}_24`
    const scriptPath = path.join(testRepoPath, `.orca-hidden-tui-visual-${runId}.mjs`)
    writeHiddenFrameScript(scriptPath, runId)
    await resetHiddenDebug(orcaPage)
    await writeHiddenFrames(orcaPage, hiddenPane.ptyId, scriptPath)
    await resetHiddenDebug(orcaPage)

    // Why: hidden-delivery gate contract — the bulk TUI frames must be
    // withheld in main (dropped after model ingestion), not delivered and
    // skipped renderer-side.
    await expect
      .poll(() => readMainHiddenDeliveryDroppedChars(orcaPage), {
        timeout: 10_000,
        message: 'visually rich hidden TUI output was not withheld from the renderer'
      })
      .toBeGreaterThan(1024)
    await expect
      .poll(() => readMainSnapshotSource(orcaPage, hiddenPane.ptyId!), {
        timeout: 10_000,
        message: 'visually rich hidden TUI source did not come from headless model'
      })
      .toBe('headless')

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    await expect
      .poll(() => getTerminalContent(orcaPage, 12_000), {
        timeout: 10_000,
        message: 'hidden TUI final frame did not restore when the workspace became visible'
      })
      .toContain(finalMarker)

    const content = await getTerminalContent(orcaPage, 12_000)
    expect(content).toContain(`Frame 024`)
    expect(content).toContain('╭')
    expect(content).toContain('├')
    expect(content).toContain('█')
    expect(content).not.toContain('Orca skipped hidden terminal output')
    await expect
      .poll(() => readTuiCursorState(orcaPage), {
        timeout: 5_000,
        message: 'restored TUI cursor stayed hidden after final frame'
      })
      .toMatchObject({
        hidden: false,
        initialized: true
      })

    const screenshotPath = testInfo.outputPath('hidden-tui-restore-final.png')
    await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
    await testInfo.attach('hidden-tui-restore-final.png', {
      path: screenshotPath,
      contentType: 'image/png'
    })
    rmSync(scriptPath, { force: true })
  })

  test('keeps newer live output correct after plain hidden output restores', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'hidden TUI restore needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const hiddenSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const hiddenPane = hiddenSnapshot.panes[0]
    if (!hiddenPane?.ptyId) {
      throw new Error('hidden visual restore pane did not bind a PTY')
    }
    const paneKey = `${hiddenSnapshot.tabId}:${hiddenPane.leafId}`

    await switchToWorktree(orcaPage, firstWorktreeId)
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), {
        timeout: 10_000,
        message: 'first worktree did not become active before hidden TUI injection'
      })
      .toBe(firstWorktreeId)

    const runId = randomUUID()
    const hiddenFrame = lowRiskRestoreFrame(runId, 40)
    const liveFrame = lowRiskRestoreFrame(runId, 41)
    const finalMarker = `VISUAL_RESTORE_FINAL_${runId}_41`
    const scriptPath = path.join(testRepoPath, `.orca-low-risk-hidden-${runId}.mjs`)
    writeLowRiskFrameScript(scriptPath, hiddenFrame)
    await resetHiddenDebug(orcaPage)
    await sendToTerminal(orcaPage, hiddenPane.ptyId, `node ${JSON.stringify(scriptPath)}\r`)
    await resetHiddenDebug(orcaPage)

    // Why: hidden-delivery gate contract — even plain hidden output is
    // dropped in main, so the withheld signal is main's dropped counter.
    await expect
      .poll(() => readMainHiddenDeliveryDroppedChars(orcaPage), {
        timeout: 10_000,
        message: 'plain hidden injected output was not withheld from the renderer'
      })
      .toBeGreaterThan(0)

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await injectPaneData(orcaPage, paneKey, liveFrame, {
      seq: hiddenFrame.length + liveFrame.length,
      rawLength: liveFrame.length
    })

    await expect
      .poll(() => getTerminalContent(orcaPage, 12_000), {
        timeout: 10_000,
        message: 'newer live TUI frame did not render after hidden output restored'
      })
      .toContain(finalMarker)

    const content = await getTerminalContent(orcaPage, 12_000)
    expect(content).toContain(`LOW_RISK_RESTORE_FRAME_${runId}_41`)
    expect(content).toContain('progress=041')
    expect(content.indexOf(`LOW_RISK_RESTORE_FRAME_${runId}_41`)).toBeGreaterThan(
      content.indexOf(`LOW_RISK_RESTORE_FRAME_${runId}_40`)
    )
    expect(content).not.toContain('Orca skipped hidden terminal output')
    await expect
      .poll(() => readTuiCursorState(orcaPage), {
        timeout: 5_000,
        message: 'live TUI cursor stayed hidden after hidden output restored'
      })
      .toMatchObject({
        hidden: false,
        initialized: true
      })
    const screenshotPath = testInfo.outputPath('hidden-tui-live-output-final.png')
    await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
    await testInfo.attach('hidden-tui-live-output-final.png', {
      path: screenshotPath,
      contentType: 'image/png'
    })
    rmSync(scriptPath, { force: true })
  })

  test('restores rich synchronized TUI output from the headless model', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'hidden TUI restore needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const hiddenSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const hiddenPane = hiddenSnapshot.panes[0]
    if (!hiddenPane?.ptyId) {
      throw new Error('hidden rich model pane did not bind a PTY')
    }
    await switchToWorktree(orcaPage, firstWorktreeId)
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), {
        timeout: 10_000,
        message: 'first worktree did not become active before hidden rich model restore'
      })
      .toBe(firstWorktreeId)

    const runId = randomUUID()
    const finalMarker = `VISUAL_RESTORE_FINAL_${runId}_24`
    const scriptPath = path.join(testRepoPath, `.orca-hidden-rich-model-${runId}.mjs`)
    writeHiddenFrameScript(scriptPath, runId)
    await resetHiddenDebug(orcaPage)
    try {
      await writeHiddenFrames(orcaPage, hiddenPane.ptyId, scriptPath)
      await resetHiddenDebug(orcaPage)

      // Why: hidden-delivery gate contract — synchronized rich frames are
      // withheld in main; the headless model snapshot is the restore source.
      await expect
        .poll(() => readMainHiddenDeliveryDroppedChars(orcaPage), {
          timeout: 10_000,
          message: 'rich hidden TUI output was not withheld from the renderer'
        })
        .toBeGreaterThan(0)
      await expect
        .poll(() => readMainSnapshotSource(orcaPage, hiddenPane.ptyId!), {
          timeout: 10_000,
          message: 'rich hidden TUI source did not come from headless model'
        })
        .toBe('headless')

      await switchToWorktree(orcaPage, secondWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)

      await expect
        .poll(() => getTerminalContent(orcaPage, 12_000), {
          timeout: 10_000,
          message: 'rich headless TUI frame did not restore when visible'
        })
        .toContain(finalMarker)

      const content = await getTerminalContent(orcaPage, 12_000)
      expect(content).toContain(`Frame 024`)
      expect(content).toContain('╭')
      expect(content).toContain('├')
      expect(content).toContain('█')
      expect(content).not.toContain('Orca skipped hidden terminal output')
      await expect
        .poll(() => readTuiCursorState(orcaPage), {
          timeout: 5_000,
          message: 'rich headless TUI cursor stayed hidden after restore'
        })
        .toMatchObject({
          hidden: false,
          initialized: true
        })

      const screenshotPath = testInfo.outputPath('hidden-rich-model-restore-final.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('hidden-rich-model-restore-final.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })

  test('keeps hidden terminal side effects live while hidden output may restore', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'hidden side-effect guard needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const hiddenSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const hiddenPane = hiddenSnapshot.panes[0]
    if (!hiddenPane?.ptyId) {
      throw new Error('hidden side-effect pane did not bind a PTY')
    }

    await switchToWorktree(orcaPage, firstWorktreeId)
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), {
        timeout: 10_000,
        message: 'first worktree did not become active before hidden side-effect burst'
      })
      .toBe(firstWorktreeId)

    const runId = randomUUID()
    const hiddenTitle = `Hidden model side effects ${runId}`
    const marker = `HIDDEN_SIDE_EFFECT_MARKER_${runId}`
    await resetHiddenDebug(orcaPage)
    await writeHiddenSideEffectBurst(orcaPage, hiddenPane.ptyId, hiddenTitle, marker)

    await expect
      .poll(() => getRuntimePaneTitle(orcaPage, hiddenSnapshot.tabId, hiddenPane.numericPaneId), {
        timeout: 10_000,
        message: 'hidden OSC title did not update renderer-visible model state'
      })
      .toBe(hiddenTitle)
    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(hiddenSnapshot.tabId), {
        timeout: 10_000,
        message: 'hidden BEL did not mark the hidden terminal tab unread'
      })
      .toBe(true)
    await expect
      .poll(() => readMainSnapshotSource(orcaPage, hiddenPane.ptyId!), {
        timeout: 10_000,
        message: 'hidden side-effect restore did not use the runtime headless snapshot'
      })
      .toBe('headless')

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expect
      .poll(() => getTerminalContent(orcaPage, 12_000), {
        timeout: 10_000,
        message: 'hidden side-effect marker did not restore when the workspace became visible'
      })
      .toContain(marker)
  })
})
