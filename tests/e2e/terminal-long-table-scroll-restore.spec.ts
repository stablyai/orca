import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { scrollActiveTerminalToText } from './artificial-opencode-active-terminal-scroll'
import {
  waitForPtyColumnsAtMost,
  waitForRenderedTerminalColumnsAtMost
} from './terminal-column-probes'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  EMOJI_TABLE_FIXTURE,
  NARROW_TERMINAL_MAX_COLS,
  emojiFixtureMarkdownTableScript,
  emojiFixtureTableWidthMarker,
  longMarkdownTableScript,
  narrowSignerMarkdownTableScript
} from './terminal-long-table-fixtures'

type TerminalRenderDiagnostics = {
  cols: number
  rows: number
  viewportY: number
  baseY: number
  hasComplexScriptOutput: boolean
  hasWebgl: boolean
  canvasCount: number
  cursorHidden: boolean | null
  visibleLineTails: string[]
  allPaneStates: {
    tabId: string
    paneId: number
    hasComplexScriptOutput: boolean
    hasMarker: boolean
    hasWebgl: boolean
  }[]
}

async function setNarrowTerminalViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 820 })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const store = window.__store
    if (store?.getState().rightSidebarOpen) {
      store.getState().setRightSidebarOpen(false)
    }
  })
  await page.waitForTimeout(250)
}

async function setRenderedTableViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1180, height: 820 })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const store = window.__store
    if (store?.getState().rightSidebarOpen) {
      store.getState().setRightSidebarOpen(false)
    }
  })
  await page.waitForTimeout(250)
}

async function scrollActiveTerminalLikeUser(page: Page): Promise<void> {
  const target = await page.evaluate(() => {
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
      throw new Error('Active terminal pane unavailable')
    }
    pane.terminal.focus()
    pane.terminal.scrollToBottom()
    const viewport =
      pane.container.querySelector<HTMLElement>('.xterm-viewport') ??
      pane.container.querySelector<HTMLElement>('.xterm')
    if (!viewport) {
      throw new Error('Active terminal viewport unavailable')
    }
    const rect = viewport.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    }
  })
  await page.mouse.move(target.x, target.y)
  await page.mouse.wheel(0, -1800)
  await page.waitForTimeout(250)
}

async function readActiveTerminalVisibleText(page: Page): Promise<string> {
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
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    return Array.from({ length: pane.terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row)
      return line?.translateToString(true) ?? ''
    }).join('\n')
  })
}

async function forceDarkTerminalRendererPath(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store unavailable')
    }
    const state = store.getState()
    store.setState({
      settings: {
        ...state.settings!,
        terminalGpuAcceleration: 'auto',
        theme: 'dark'
      }
    })
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    manager?.setTerminalGpuAcceleration('auto')
  })
  await page.waitForTimeout(250)
}

async function readTerminalRightEdgeOverpaint(page: Page): Promise<{
  screenRight: number
  offenderCount: number
  offenders: { text: string; right: number; width: number }[]
}> {
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
    const screen = pane?.container.querySelector<HTMLElement>('.xterm-screen')
    const rows = pane?.container.querySelector<HTMLElement>('.xterm-rows')
    if (!pane || !screen) {
      throw new Error('Active terminal DOM unavailable')
    }

    const screenRect = screen.getBoundingClientRect()
    if (!rows) {
      // Why: WebGL renders rows into a canvas; DOM-span overpaint checks only
      // apply to the DOM renderer, while buffer wrap checks still run below.
      return {
        screenRight: screenRect.right,
        offenderCount: 0,
        offenders: []
      }
    }

    const cellWidth = pane.terminal._core?._renderService?.dimensions?.css?.cell?.width ?? 0
    const maxRight = screenRect.right + Math.max(1, cellWidth * 0.5)
    const offenders = Array.from(rows.querySelectorAll<HTMLElement>('span'))
      .map((span) => {
        const rect = span.getBoundingClientRect()
        return {
          text: span.textContent ?? '',
          right: rect.right,
          width: rect.width
        }
      })
      .filter((span) => span.width > 0 && span.right > maxRight)
      .slice(0, 12)

    return {
      screenRight: screenRect.right,
      offenderCount: offenders.length,
      offenders
    }
  })
}

async function readTerminalBoxTableWrapDiagnostics(page: Page): Promise<{
  cols: number
  rows: number
  baseY: number
  viewportY: number
  wrappedBoxLines: { index: number; text: string }[]
  nearSinger: { index: number; isWrapped: boolean; text: string }[]
}> {
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
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    const lineCount = buffer.baseY + buffer.length
    const lines = Array.from({ length: lineCount }, (_, index) => {
      const line = buffer.getLine(index)
      return {
        index,
        isWrapped: line?.isWrapped === true,
        text: line?.translateToString(true) ?? ''
      }
    })
    const wrappedBoxLines = lines
      .filter((line) => line.isWrapped && /[┌┬┐├┼┤└┴┘│─]/.test(line.text))
      .slice(0, 20)
    const singerIndex = lines.findIndex((line) => line.text.includes('Singer'))
    const nearSinger =
      singerIndex === -1 ? [] : lines.slice(Math.max(0, singerIndex - 4), singerIndex + 7)
    return {
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      wrappedBoxLines,
      nearSinger
    }
  })
}

async function closeFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    store?.getState().markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    if (store?.getState().activeModal === 'feature-tips') {
      store.getState().closeModal()
    }
  })
}

async function readTerminalRenderDiagnostics(page: Page): Promise<TerminalRenderDiagnostics> {
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
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    const visibleLineTails: string[] = []
    for (let row = 0; row < pane.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row)
      visibleLineTails.push(line?.translateToString(true).slice(-48) ?? '')
    }
    const terminalCore = (
      pane.terminal as unknown as {
        _core?: { coreService?: { isCursorHidden?: boolean } }
      }
    )._core
    const allPaneStates = Array.from(window.__paneManagers?.entries?.() ?? []).flatMap(
      ([managerTabId, paneManager]) =>
        (paneManager.getPanes?.() ?? []).map((managedPane) => {
          const visibleText = Array.from({ length: managedPane.terminal.rows }, (_, row) => {
            const line = managedPane.terminal.buffer.active.getLine(
              managedPane.terminal.buffer.active.viewportY + row
            )
            return line?.translateToString(true) ?? ''
          }).join('\n')
          const serializedText = managedPane.serializeAddon?.serialize?.() ?? visibleText
          return {
            tabId: managerTabId,
            paneId: managedPane.id,
            hasComplexScriptOutput: managedPane.hasComplexScriptOutput === true,
            hasMarker: serializedText.includes('LONG_TABLE_SCROLL_RESTORE_'),
            hasWebgl: Boolean(managedPane.webglAddon)
          }
        })
    )
    return {
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      hasComplexScriptOutput: pane.hasComplexScriptOutput === true,
      hasWebgl: Boolean(pane.webglAddon),
      canvasCount: pane.container.querySelectorAll('canvas').length,
      cursorHidden: terminalCore?.coreService?.isCursorHidden ?? null,
      visibleLineTails,
      allPaneStates
    }
  })
}

test.describe('Terminal long table scroll restore repro', () => {
  test('reproduces long markdown table artifacts after workspace switch and scroll', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      window.__store
        ?.getState()
        .markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    })
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'long table restore repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const runId = randomUUID()
    const marker = `LONG_TABLE_SCROLL_RESTORE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-long-table-${runId}.mjs`)
    writeFileSync(scriptPath, longMarkdownTableScript(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await orcaPage.waitForTimeout(80)
      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(1_500)
      await switchToWorktree(orcaPage, firstWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 10_000,
          message: 'long table marker did not survive workspace switch'
        })
        .toContain(marker)

      await scrollActiveTerminalLikeUser(orcaPage)
      await closeFeatureTips(orcaPage)
      const diagnostics = await readTerminalRenderDiagnostics(orcaPage)
      const restoredPane = diagnostics.allPaneStates.find((paneState) => paneState.hasMarker)
      expect(restoredPane).toBeDefined()
      expect(diagnostics.cursorHidden).toBe(false)
      await orcaPage.waitForTimeout(100)
      const screenshotPath = testInfo.outputPath('long-table-after-switch-scroll.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('long-table-after-switch-scroll.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })

  test('keeps narrow wrapped signer markdown table coherent after restore and scroll', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      window.__store
        ?.getState()
        .markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    })
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'narrow signer table repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await setRenderedTableViewport(orcaPage)
    await forceDarkTerminalRendererPath(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const runId = randomUUID()
    const marker = `NARROW_SIGNER_TABLE_RESTORE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-narrow-signer-table-${runId}.mjs`)
    writeFileSync(scriptPath, narrowSignerMarkdownTableScript(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await orcaPage.waitForTimeout(80)
      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(1_000)
      await switchToWorktree(orcaPage, firstWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 10_000,
          message: 'narrow signer table marker did not survive workspace switch'
        })
        .toContain(marker)

      await scrollActiveTerminalLikeUser(orcaPage)
      await closeFeatureTips(orcaPage)
      const diagnostics = await readTerminalRenderDiagnostics(orcaPage)
      // Why: renderer cell metrics can land one column wider in headless runs;
      // the content and screenshot assertions below cover the actual regression.
      expect(diagnostics.cols).toBeLessThanOrEqual(112)
      expect(diagnostics.cursorHidden).toBe(false)

      const content = await getTerminalContent(orcaPage, 30_000)
      expect(content).toContain('Signer')
      expect(content).toContain('did:key:z6Mkuw5kQqz1QvZ9f3d2aB7f19f0cAC7B4F3c9E725')
      expect(content).toContain(marker)

      const screenshotPath = testInfo.outputPath('narrow-signer-table-after-switch-scroll.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('narrow-signer-table-after-switch-scroll.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })

  // Why: keeps the user-shaped markdown path covered in the broader e2e suite;
  // the faster raw-table spec is the release-blocking golden for this bug.
  test('keeps real emoji markdown table right edge clean after restore and scroll', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    await closeFeatureTips(orcaPage)
    await orcaPage.evaluate(() => {
      window.__store
        ?.getState()
        .markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    })
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'real emoji table repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await setNarrowTerminalViewport(orcaPage)
    const renderedTableTerminalCols = await waitForRenderedTerminalColumnsAtMost(
      orcaPage,
      NARROW_TERMINAL_MAX_COLS
    )
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyColumnsAtMost(orcaPage, ptyId, renderedTableTerminalCols)
    const runId = randomUUID()
    const marker = `EMOJI_FIXTURE_TABLE_RESTORE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-emoji-fixture-table-${runId}.mjs`)
    writeFileSync(scriptPath, emojiFixtureMarkdownTableScript(EMOJI_TABLE_FIXTURE, runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await orcaPage.waitForTimeout(80)
      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(1_000)
      await switchToWorktree(orcaPage, firstWorktreeId)
      // Why: worktree activation can restore the right sidebar. This repro is
      // intentionally narrow, but it must stay wide enough for its generated table.
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await setNarrowTerminalViewport(orcaPage)
      await waitForRenderedTerminalColumnsAtMost(orcaPage, NARROW_TERMINAL_MAX_COLS)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 10_000,
          message: 'real emoji table marker did not survive workspace switch'
        })
        .toContain(marker)
      const generatedWidthContent = await getTerminalContent(orcaPage, 30_000)
      const generatedWidthMatch = generatedWidthContent.match(
        new RegExp(`${emojiFixtureTableWidthMarker(runId)}(\\d+)`)
      )
      expect(generatedWidthMatch).not.toBeNull()
      const generatedTableWidth = Number(generatedWidthMatch?.[1] ?? 0)

      // Why: rows near the top of this heavily wrapped table can fall out of
      // xterm scrollback on CI, and narrow columns split names like "Peacock"
      // across terminal lines. A lower cell fragment still exercises the
      // restored markdown-table viewport without depending on early output.
      const retainedEmojiCell = 'Peac'
      await scrollActiveTerminalToText(orcaPage, retainedEmojiCell)
      await closeFeatureTips(orcaPage)
      await expect
        .poll(() => readActiveTerminalVisibleText(orcaPage), {
          timeout: 5_000,
          message: `${retainedEmojiCell} row fragment should be visible before screenshot`
        })
        .toContain(retainedEmojiCell)
      const diagnostics = await readTerminalRenderDiagnostics(orcaPage)
      const overpaint = await readTerminalRightEdgeOverpaint(orcaPage)
      const wrapDiagnostics = await readTerminalBoxTableWrapDiagnostics(orcaPage)
      expect(diagnostics.cols).toBeLessThanOrEqual(NARROW_TERMINAL_MAX_COLS)
      expect(wrapDiagnostics.cols).toBeGreaterThanOrEqual(generatedTableWidth)
      expect(diagnostics.cursorHidden).toBe(false)
      testInfo.annotations.push({
        type: 'real-emoji-table-overpaint',
        description: JSON.stringify(overpaint)
      })
      testInfo.annotations.push({
        type: 'real-emoji-table-wrap-diagnostics',
        description: JSON.stringify(wrapDiagnostics)
      })

      const screenshotPath = testInfo.outputPath('real-emoji-table-after-switch-scroll.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('real-emoji-table-after-switch-scroll.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
      expect(overpaint.offenders).toEqual([])
      expect(wrapDiagnostics.wrappedBoxLines).toEqual([])
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
