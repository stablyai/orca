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
  __terminalHiddenSnapshotOverride?: {
    setPending: (
      ptyId: string,
      snapshot: { data: string; cols: number; rows: number; seq: number; source: 'headless' }
    ) => void
    resolve: (ptyId: string) => void
    clear: (ptyId: string) => void
  }
}

type HiddenTuiDebugSnapshot = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
  hiddenRendererMode2031ReplyCount: number
}

function tuiFrame(runId: string, frame: number): string {
  const rows = [
    `OpenCode visual restore ${runId}`,
    `Frame ${String(frame).padStart(3, '0')}`,
    `Status ${frame % 2 === 0 ? 'thinking' : 'streaming'}`,
    `Input echo ${'#'.repeat((frame % 18) + 1)}`,
    `Diff +${frame * 3} -${frame}`,
    `VISUAL_RESTORE_FINAL_${runId}_${frame}`
  ]
  return [
    '\x1b[?2026h',
    '\x1b[?1049h',
    '\x1b[2J\x1b[H',
    rows.map((row) => `\x1b[2;36m${row}\x1b[0m`).join('\r\n'),
    '\x1b[?2026l'
  ].join('')
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

async function installDelayedMainSnapshot(
  page: Page,
  ptyId: string,
  snapshot: { data: string; cols: number; rows: number; seq: number; source: 'headless' }
): Promise<void> {
  await page.evaluate(
    ({ ptyId, snapshot }) => {
      ;(window as HiddenTuiWindow).__terminalHiddenSnapshotOverride?.setPending(ptyId, snapshot)
    },
    { ptyId, snapshot }
  )
}

async function resolveDelayedMainSnapshot(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((ptyId) => {
    ;(window as HiddenTuiWindow).__terminalHiddenSnapshotOverride?.resolve(ptyId)
  }, ptyId)
}

async function clearDelayedMainSnapshot(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((ptyId) => {
    ;(window as HiddenTuiWindow).__terminalHiddenSnapshotOverride?.clear(ptyId)
  }, ptyId)
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
  test('restores skipped hidden full-screen TUI output without visible corruption', async ({
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
        message: 'hidden TUI output did not exercise the skipped-renderer path'
      })
      .toBeGreaterThan(0)
    await expect
      .poll(() => readMainSnapshotSource(orcaPage, hiddenPane.ptyId!), {
        timeout: 10_000,
        message: 'hidden TUI restore did not use the runtime headless snapshot'
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
    expect(content).not.toContain('Orca skipped hidden terminal output')

    const screenshotPath = testInfo.outputPath('hidden-tui-restore-final.png')
    await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
    await testInfo.attach('hidden-tui-restore-final.png', {
      path: screenshotPath,
      contentType: 'image/png'
    })
    rmSync(scriptPath, { force: true })
  })

  test('keeps newer live TUI output visually correct while hidden restore is in flight', async ({
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
    const hiddenFrame = tuiFrame(runId, 40)
    const liveFrame = tuiFrame(runId, 41)
    const finalMarker = `VISUAL_RESTORE_FINAL_${runId}_41`
    await resetHiddenDebug(orcaPage)
    await injectPaneData(orcaPage, paneKey, hiddenFrame, {
      seq: hiddenFrame.length,
      rawLength: hiddenFrame.length
    })

    await expect
      .poll(async () => (await readHiddenDebug(orcaPage))?.hiddenRendererSkipCount ?? 0, {
        timeout: 10_000,
        message: 'hidden injected TUI output did not skip renderer parsing'
      })
      .toBeGreaterThan(0)

    await installDelayedMainSnapshot(orcaPage, hiddenPane.ptyId, {
      data: hiddenFrame,
      cols: 120,
      rows: 40,
      seq: hiddenFrame.length,
      source: 'headless'
    })

    try {
      await switchToWorktree(orcaPage, secondWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await injectPaneData(orcaPage, paneKey, liveFrame, {
        seq: hiddenFrame.length + liveFrame.length,
        rawLength: liveFrame.length
      })
      await resolveDelayedMainSnapshot(orcaPage, hiddenPane.ptyId)

      await expect
        .poll(() => getTerminalContent(orcaPage, 12_000), {
          timeout: 10_000,
          message: 'newer live TUI frame did not render after delayed hidden snapshot'
        })
        .toContain(finalMarker)

      const content = await getTerminalContent(orcaPage, 12_000)
      expect(content).toContain('Frame 041')
      expect(content).not.toContain('Frame 040')
      expect(content).not.toContain('Orca skipped hidden terminal output')

      const screenshotPath = testInfo.outputPath('hidden-tui-delayed-restore-final.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('hidden-tui-delayed-restore-final.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      await clearDelayedMainSnapshot(orcaPage, hiddenPane.ptyId)
    }
  })

  test('keeps hidden terminal side effects live while renderer output is skipped', async ({
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
        message: 'hidden side-effect output did not exercise the skipped-renderer path'
      })
      .toBeGreaterThan(0)
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
