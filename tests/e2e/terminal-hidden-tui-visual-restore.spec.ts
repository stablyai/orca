import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
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
  __terminalPtyOutputDebug?: {
    reset: () => void
    snapshot: () => {
      hiddenRendererSkipCount: number
      hiddenRendererSkippedChars: number
      hiddenRendererMode2031ReplyCount: number
    }
  }
}

type HiddenTuiDebugSnapshot = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
  hiddenRendererMode2031ReplyCount: number
}

type TuiCursorState = {
  hidden: boolean | null
  initialized: boolean | null
  cursorElementVisible: boolean
  cursorCanvasPresent: boolean
}

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
  await page.evaluate(() => {
    ;(window as HiddenTuiWindow).__terminalPtyOutputDebug?.reset()
  })
}

function writeHiddenFrameScript(scriptPath: string, runId: string): void {
  const frames = Array.from({ length: 25 }, (_, frame) => tuiFrame(runId, frame))
  writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(frames.join(''))})\n`)
}

async function writeHiddenFrames(page: Page, ptyId: string, scriptPath: string): Promise<void> {
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
}

async function readHiddenDebug(page: Page): Promise<HiddenTuiDebugSnapshot | null> {
  return page.evaluate(() => {
    return (window as HiddenTuiWindow).__terminalPtyOutputDebug?.snapshot() ?? null
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
    const cursorElement = pane.container.querySelector<HTMLElement>('.xterm-cursor')
    const cursorRect = cursorElement?.getBoundingClientRect()
    const cursorStyle = cursorElement ? window.getComputedStyle(cursorElement) : null
    return {
      hidden: terminalCore?.coreService?.isCursorHidden ?? null,
      initialized: terminalCore?.coreService?.isCursorInitialized ?? null,
      // Why: a blinking DOM cursor may be transparent during the sampled frame;
      // disappearance regressions remove the laid-out cursor element/layer.
      cursorElementVisible:
        !!cursorElement &&
        !!cursorRect &&
        cursorRect.width > 0 &&
        cursorRect.height > 0 &&
        cursorStyle?.display !== 'none' &&
        cursorStyle?.visibility !== 'hidden',
      cursorCanvasPresent:
        pane.container.querySelector<HTMLCanvasElement>('.xterm-cursor-layer canvas') !== null
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

    await expect
      .poll(async () => (await readHiddenDebug(orcaPage))?.hiddenRendererSkipCount ?? 0, {
        timeout: 10_000,
        message: 'visually rich hidden TUI output should stay on the live xterm path'
      })
      .toBe(0)

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

  test('keeps newer live output correct after hidden output stayed live', async ({
    orcaPage
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
    await resetHiddenDebug(orcaPage)
    await injectPaneData(orcaPage, paneKey, hiddenFrame, {
      seq: hiddenFrame.length,
      rawLength: hiddenFrame.length
    })

    await expect
      .poll(async () => (await readHiddenDebug(orcaPage))?.hiddenRendererSkipCount ?? 0, {
        timeout: 10_000,
        message: 'hidden injected output should stay on the live xterm path for release'
      })
      .toBe(0)

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
        message: 'newer live TUI frame did not render after hidden output stayed live'
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
        message: 'live TUI cursor stayed hidden after hidden output stayed live'
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
  })

  test('keeps hidden terminal side effects live while hidden output stays live', async ({
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
      .poll(async () => (await readHiddenDebug(orcaPage))?.hiddenRendererSkipCount ?? 0, {
        timeout: 10_000,
        message: 'hidden side-effect output should stay on the live xterm path for release'
      })
      .toBe(0)
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
