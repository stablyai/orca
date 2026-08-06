import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

type TerminalViewportSnapshot = {
  cols: number
  rows: number
  viewportY: number
  baseY: number
  firstVisibleLine: string
}

function transcriptFixture(runId: string): string {
  return `
const rows = 420
for (let row = 0; row < rows; row += 1) {
  const history = 'CODEX_CHAT_HISTORY_${runId}_' + String(row).padStart(4, '0')
  const body = ' assistant response ' + 'x'.repeat(92)
  process.stdout.write(history + body + '\\r\\n')
}
process.stdout.write('CODEX_CHAT_HISTORY_${runId}_READY\\r\\n')
process.stdout.on('resize', () => {
  process.stdout.write('CODEX_CHAT_HISTORY_${runId}_RESIZED\\r\\n')
})
setInterval(() => {}, 1_000)
`
}

async function readActiveTerminalViewport(page: Page): Promise<TerminalViewportSnapshot> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    return {
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      firstVisibleLine: buffer.getLine(buffer.viewportY)?.translateToString(true) ?? ''
    }
  })
}

async function enableTerminalAccessibilityDom(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((targetPtyId) => {
    const pane = Array.from(window.__paneManagers?.values() ?? [])
      .flatMap((manager) => manager.getPanes?.() ?? [])
      .find((candidate) => candidate.container.dataset.ptyId === targetPtyId)
    if (!pane) {
      throw new Error(`Terminal pane ${targetPtyId} is unavailable`)
    }
    // xterm paints to canvas by default; screen-reader mode mirrors visible rows into the DOM.
    pane.terminal.options.screenReaderMode = true
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  }, ptyId)
  await expect(
    page.locator(`[data-pty-id=${JSON.stringify(ptyId)}] .xterm-accessibility-tree`)
  ).toBeAttached({ timeout: 10_000 })
}

async function scrollActiveTerminalToMarker(page: Page, marker: string): Promise<void> {
  await page.evaluate((searchMarker) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const target = pane.container.querySelector<HTMLElement>('.xterm') ?? pane.container
    target.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: -1200
      })
    )
    const buffer = pane.terminal.buffer.active
    const markerLine = Array.from(
      { length: buffer.baseY + buffer.length },
      (_, lineY) => lineY
    ).find((lineY) => buffer.getLine(lineY)?.translateToString(true).includes(searchMarker))
    if (markerLine === undefined) {
      throw new Error(`Terminal marker not found: ${searchMarker}`)
    }
    pane.terminal.scrollToLine(markerLine)
    pane.container
      .querySelector<HTMLElement>('.xterm-viewport')
      ?.dispatchEvent(new Event('scroll', { bubbles: true }))
  }, marker)
  await page.waitForTimeout(50)
}

test.describe('Terminal scroll resize behavior', () => {
  test('bottom-locks scrolled Codex history across a narrow/wide resize', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-scroll-resize-${runId}.mjs`)
    writeFileSync(scriptPath, transcriptFixture(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 15_000,
          message: 'Codex-shaped transcript did not reach the terminal'
        })
        .toContain(`CODEX_CHAT_HISTORY_${runId}_READY`)

      const pinMarker = `CODEX_CHAT_HISTORY_${runId}_0249`
      await enableTerminalAccessibilityDom(orcaPage, ptyId)
      const terminalDom = orcaPage.locator(
        `[data-pty-id=${JSON.stringify(ptyId)}] .xterm-accessibility-tree`
      )
      await scrollActiveTerminalToMarker(orcaPage, pinMarker)
      await expect(terminalDom).toContainText(pinMarker, { timeout: 10_000 })
      const beforeResize = await readActiveTerminalViewport(orcaPage)
      expect(beforeResize.viewportY).toBeGreaterThan(0)
      expect(beforeResize.viewportY).toBeLessThan(beforeResize.baseY)
      const beforeScreenshotPath = testInfo.outputPath('terminal-scroll-resize-before.png')
      await orcaPage.screenshot({ path: beforeScreenshotPath, fullPage: true })
      await testInfo.attach('terminal-scroll-resize-before', {
        path: beforeScreenshotPath,
        contentType: 'image/png'
      })

      await orcaPage.setViewportSize({ width: 760, height: 820 })
      await expect
        .poll(() => readActiveTerminalViewport(orcaPage).then((snapshot) => snapshot.cols), {
          timeout: 15_000,
          message: 'terminal did not settle after narrowing the window'
        })
        .not.toBe(beforeResize.cols)

      const narrowResize = await readActiveTerminalViewport(orcaPage)
      expect(narrowResize.viewportY).toBe(narrowResize.baseY)
      await orcaPage.setViewportSize({ width: 1_320, height: 820 })
      await expect
        .poll(() => readActiveTerminalViewport(orcaPage).then((snapshot) => snapshot.cols), {
          timeout: 15_000,
          message: 'terminal did not settle after widening the window'
        })
        .not.toBe(narrowResize.cols)

      const afterResize = await readActiveTerminalViewport(orcaPage)
      expect(afterResize.viewportY).toBe(afterResize.baseY)
      console.log(
        '[terminal-scroll-resize-bottom-lock]',
        JSON.stringify({
          before: {
            cols: beforeResize.cols,
            rows: beforeResize.rows,
            viewportY: beforeResize.viewportY,
            baseY: beforeResize.baseY,
            firstVisibleLine: beforeResize.firstVisibleLine
          },
          narrow: { cols: narrowResize.cols, rows: narrowResize.rows },
          after: {
            cols: afterResize.cols,
            rows: afterResize.rows,
            viewportY: afterResize.viewportY,
            baseY: afterResize.baseY,
            firstVisibleLine: afterResize.firstVisibleLine
          }
        })
      )
      await expect(terminalDom).toContainText(`CODEX_CHAT_HISTORY_${runId}_READY`, {
        timeout: 10_000
      })
      const afterScreenshotPath = testInfo.outputPath('terminal-scroll-resize-after.png')
      await orcaPage.screenshot({ path: afterScreenshotPath, fullPage: true })
      await testInfo.attach('terminal-scroll-resize-after', {
        path: afterScreenshotPath,
        contentType: 'image/png'
      })
      console.log(
        '[terminal-scroll-resize-bottom-lock-screenshots]',
        JSON.stringify({ before: beforeScreenshotPath, after: afterScreenshotPath })
      )
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
