import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { scrollActiveTerminalToText } from './artificial-opencode-active-terminal-scroll'

type BrowserTerminalPane = {
  terminal: {
    cols: number
    rows: number
    buffer: {
      active: {
        baseY: number
        length: number
        viewportY: number
        getLine: (index: number) =>
          | {
              isWrapped?: boolean
              translateToString: (trimRight?: boolean) => string
            }
          | undefined
      }
    }
    focus: () => void
    scrollToBottom: () => void
    _core?: {
      coreService?: { isCursorHidden?: boolean }
      _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } }
    }
  }
  container: HTMLElement
}

type RawTableDebugWindow = Window & {
  getActiveTestPane?: () => BrowserTerminalPane
}

const EMOJI_TABLE_FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures', 'terminal-emoji-table.md'),
  'utf8'
)
const RAW_EMOJI_BOX_TABLE_COLUMN_WIDTHS = [5, 17, 10, 25, 23, 12, 10, 10] as const
const RAW_EMOJI_BOX_TABLE_WIDTH =
  RAW_EMOJI_BOX_TABLE_COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0) +
  RAW_EMOJI_BOX_TABLE_COLUMN_WIDTHS.length * 3 +
  1

function rawEmojiFixtureBoxTableScript(table: string, runId: string): string {
  const marker = `RAW_EMOJI_FIXTURE_TABLE_RESTORE_${runId}`
  return `
const table = ${JSON.stringify(table)}
const widths = ${JSON.stringify(RAW_EMOJI_BOX_TABLE_COLUMN_WIDTHS)}
const border = {
  top: ['┌', '┬', '┐'],
  middle: ['├', '┼', '┤'],
  bottom: ['└', '┴', '┘'],
  vertical: '│',
  horizontal: '─'
}
const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null
function splitMarkdownRow(row) {
  return row.trim().slice(1, -1).split('|').map((cell) => cell.trim())
}
function isSeparatorRow(row) {
  return /^\\|(?:\\s*:?-+:?\\s*\\|)+\\s*$/.test(row)
}
function graphemes(text) {
  if (!segmenter) return Array.from(String(text))
  return Array.from(segmenter.segment(String(text)), (part) => part.segment)
}
function isWideCodePoint(codePoint) {
  return codePoint > 0xffff ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
}
function cellWidth(text) {
  let width = 0
  for (const cluster of graphemes(text)) {
    if (cluster.includes('\\u200d')) {
      width += 2
      continue
    }
    const codePoint = cluster.codePointAt(0)
    if (codePoint === undefined || (codePoint >= 0x0300 && codePoint <= 0x036f)) continue
    if (codePoint === 0xfe0f || codePoint === 0x200d) continue
    width += isWideCodePoint(codePoint) ? 2 : 1
  }
  return width
}
function clipCell(value, width) {
  let text = ''
  let used = 0
  for (const cluster of graphemes(value)) {
    const nextWidth = cellWidth(cluster)
    if (used + nextWidth > width) break
    text += cluster
    used += nextWidth
  }
  return text + ' '.repeat(Math.max(0, width - used))
}
function rule(parts) {
  return parts[0] + widths.map((width) => border.horizontal.repeat(width + 2)).join(parts[1]) + parts[2]
}
function renderRow(cells) {
  return (
    border.vertical +
    widths.map((width, index) => ' ' + clipCell(cells[index] ?? '', width) + ' ').join(border.vertical) +
    border.vertical
  )
}
const parsedRows = table
  .split(/\\r?\\n/)
  .filter((row) => row.trim().startsWith('|') && !isSeparatorRow(row))
  .map(splitMarkdownRow)
const rendered = [rule(border.top)]
for (const [index, row] of parsedRows.entries()) {
  rendered.push(renderRow(row))
  rendered.push(rule(index === parsedRows.length - 1 ? border.bottom : border.middle))
}
process.stdout.write('\\x1b[?2026h\\x1b[2J\\x1b[H')
process.stdout.write(rendered.join('\\r\\n'))
process.stdout.write('\\r\\n${marker}\\r\\n')
process.stdout.write('\\x1b[?2026l')
`
}

function rawEmojiFixtureCompletionMarker(runId: string): string {
  return `RAW_EMOJI_FIXTURE_TABLE_RESTORE_${runId}`
}

async function setWideRenderedTableViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1480, height: 820 })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const store = window.__store
    if (store?.getState().rightSidebarOpen) {
      store.getState().setRightSidebarOpen(false)
    }
  })
  await page.waitForTimeout(250)
}

async function waitForActiveTerminalColumns(
  page: Page,
  minimumCols: number,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          let pane: ReturnType<NonNullable<RawTableDebugWindow['getActiveTestPane']>> = null
          try {
            pane = (window as RawTableDebugWindow).getActiveTestPane?.() ?? null
          } catch {
            return 0
          }
          return pane?.terminal.cols ?? 0
        }),
      {
        timeout: timeoutMs,
        message: `active terminal did not resize to at least ${minimumCols} columns`
      }
    )
    .toBeGreaterThanOrEqual(minimumCols)
}

async function readTerminalBoxTableWrapDiagnostics(page: Page): Promise<{
  cols: number
  rows: number
  baseY: number
  viewportY: number
  wrappedBoxLines: { index: number; text: string }[]
  wrappedSingerContinuationLines: { index: number; text: string }[]
  nearSinger: { index: number; isWrapped: boolean; text: string }[]
}> {
  return page.evaluate(() => {
    const pane = (window as RawTableDebugWindow).getActiveTestPane?.()
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
    const wrappedSingerContinuationLines = lines
      .filter((line) => line.isWrapped && /U\\+1F3A4|A stage performer|Talented/.test(line.text))
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
      wrappedSingerContinuationLines,
      nearSinger
    }
  })
}

async function readTerminalRightEdgeOverpaint(page: Page): Promise<{
  screenRight: number
  offenderCount: number
  offenders: { text: string; right: number; width: number }[]
}> {
  return page.evaluate(() => {
    const pane = (window as RawTableDebugWindow).getActiveTestPane?.()
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
    const rows = pane.container.querySelector<HTMLElement>('.xterm-rows')
    if (!screen) {
      throw new Error('Active terminal DOM unavailable')
    }

    const screenRect = screen.getBoundingClientRect()
    if (!rows) {
      // Why: WebGL renders rows into a canvas, so DOM-span overpaint checks only
      // apply when the DOM renderer is active. Buffer wrap checks still run below.
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

async function readVisibleSingerRowGeometry(page: Page): Promise<{
  cols: number
  screenRight: number
  rowRight: number
  rowText: string
}> {
  return page.evaluate(() => {
    const pane = (window as RawTableDebugWindow).getActiveTestPane?.()
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
    const rows = pane.container.querySelector<HTMLElement>('.xterm-rows')
    if (!screen) {
      throw new Error('Active terminal DOM unavailable')
    }
    const screenRect = screen.getBoundingClientRect()
    const buffer = pane.terminal.buffer.active
    const visibleLine = Array.from(
      { length: pane.terminal.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    ).find((text) => text.includes('Singer'))
    const scrollbackLine =
      visibleLine ??
      Array.from(
        { length: buffer.baseY + buffer.length },
        (_, index) => buffer.getLine(index)?.translateToString(true) ?? ''
      ).find((text) => text.includes('Singer'))
    if (!scrollbackLine) {
      throw new Error('Singer row buffer line unavailable')
    }
    const cellWidth = pane.terminal._core?._renderService?.dimensions?.css?.cell?.width ?? 0
    const bufferGeometry = {
      cols: pane.terminal.cols,
      screenRight: screenRect.right,
      rowRight: screenRect.left + pane.terminal.cols * cellWidth,
      rowText: scrollbackLine
    }
    if (!rows) {
      return bufferGeometry
    }
    const row = Array.from(rows.children).find((element) =>
      (element.textContent ?? '').includes('Singer')
    ) as HTMLElement | undefined
    if (!row) {
      // Why: xterm can repaint DOM rows between scroll and measurement; the
      // terminal buffer still gives a stable right-edge bound for the golden.
      return bufferGeometry
    }
    const rowRect = row.getBoundingClientRect()
    return {
      cols: pane.terminal.cols,
      screenRight: screenRect.right,
      rowRight: rowRect.right,
      rowText: row.textContent ?? ''
    }
  })
}

async function readTerminalRenderDiagnostics(page: Page): Promise<{
  hasWebgl: boolean
  hasComplexScriptOutput: boolean
  cursorHidden: boolean | null
  terminalGpuAcceleration?: string
  gpuRenderingEnabled?: boolean
  webglAttachmentDeferred?: boolean
  webglDisabledAfterContextLoss?: boolean
  platform: string
  userAgent: string
  webgl2Available: boolean
}> {
  return page.evaluate(() => {
    const pane = (window as RawTableDebugWindow).getActiveTestPane?.()
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const terminalCore = pane.terminal._core
    const canvas = document.createElement('canvas')
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
    const renderingDiagnostics = manager
      ?.getRenderingDiagnostics()
      .find((diagnostic) => diagnostic.paneId === pane.id)
    return {
      hasWebgl: renderingDiagnostics?.hasWebgl ?? false,
      hasComplexScriptOutput: renderingDiagnostics?.hasComplexScriptOutput ?? false,
      cursorHidden: terminalCore?.coreService?.isCursorHidden ?? null,
      terminalGpuAcceleration: renderingDiagnostics?.terminalGpuAcceleration,
      gpuRenderingEnabled: renderingDiagnostics?.gpuRenderingEnabled,
      webglAttachmentDeferred: renderingDiagnostics?.webglAttachmentDeferred,
      webglDisabledAfterContextLoss: renderingDiagnostics?.webglDisabledAfterContextLoss,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      webgl2Available: canvas.getContext('webgl2') !== null
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

async function expectAutoWebgl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      return false
    }
    if (!navigator.platform.includes('Linux') && !navigator.userAgent.includes('Linux')) {
      return true
    }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) {
      return false
    }
    const renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '')
    const vendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '')
    return !/\b(swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|basic render|virgl|svga3d)\b/i.test(
      `${vendor} ${renderer}`
    )
  })
}

test.describe('Terminal raw emoji table scroll restore repro', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.evaluate(() => {
      ;(window as RawTableDebugWindow).getActiveTestPane = () => {
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
        return pane as BrowserTerminalPane
      }
    })
  })

  // Why: `auto` should start on the fast renderer for ordinary terminal output;
  // the emoji table golden below proves complex output does not disable it.
  test('uses WebGL by default for ordinary terminal output when available @terminal-rendering-golden', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await closeFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `ORCA_AUTO_WEBGL_SMOKE_${randomUUID()}`

    await sendToTerminal(orcaPage, ptyId, `printf ${JSON.stringify(`${marker}\\n`)}\r`)
    await waitForTerminalOutput(orcaPage, marker, 10_000)

    const diagnostics = await readTerminalRenderDiagnostics(orcaPage)
    expect(diagnostics.hasComplexScriptOutput).toBe(false)
    expect(diagnostics.hasWebgl).toBe(await expectAutoWebgl(orcaPage))
    expect(diagnostics.cursorHidden).toBe(false)
  })

  // Why: this is the minimal golden for the v1.4.51 regression. It fails if
  // xterm underfits by one scrollbar column or counts ZWJ emoji as width 4.
  test('keeps raw emoji box table aligned after restore and scroll @terminal-rendering-golden', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    await closeFeatureTips(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'raw emoji table repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await setWideRenderedTableViewport(orcaPage)
    await waitForActiveTerminalColumns(orcaPage, RAW_EMOJI_BOX_TABLE_WIDTH)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-raw-emoji-fixture-table-${runId}.mjs`)
    writeFileSync(scriptPath, rawEmojiFixtureBoxTableScript(EMOJI_TABLE_FIXTURE, runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      await orcaPage.waitForTimeout(80)
      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(1_000)
      await switchToWorktree(orcaPage, firstWorktreeId)
      // Why: activating another worktree can restore the right sidebar. This
      // golden is about terminal renderer restore at a deliberately wide width.
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await setWideRenderedTableViewport(orcaPage)
      await waitForActiveTerminalColumns(orcaPage, RAW_EMOJI_BOX_TABLE_WIDTH)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 30_000,
          message: 'raw emoji table did not finish streaming after workspace switch'
        })
        .toContain(rawEmojiFixtureCompletionMarker(runId))

      await scrollActiveTerminalToText(orcaPage, 'Singer')
      await closeFeatureTips(orcaPage)
      const diagnostics = await readTerminalRenderDiagnostics(orcaPage)
      const overpaint = await readTerminalRightEdgeOverpaint(orcaPage)
      const wrapDiagnostics = await readTerminalBoxTableWrapDiagnostics(orcaPage)
      const singerGeometry = await readVisibleSingerRowGeometry(orcaPage)
      testInfo.annotations.push({
        type: 'raw-emoji-table-singer-geometry',
        description: JSON.stringify(singerGeometry)
      })
      testInfo.annotations.push({
        type: 'raw-emoji-table-overpaint',
        description: JSON.stringify(overpaint)
      })
      testInfo.annotations.push({
        type: 'raw-emoji-table-wrap-diagnostics',
        description: JSON.stringify(wrapDiagnostics)
      })

      const screenshotPath = testInfo.outputPath('raw-emoji-table-after-switch-scroll.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('raw-emoji-table-after-switch-scroll.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })

      expect(wrapDiagnostics.cols).toBeGreaterThanOrEqual(RAW_EMOJI_BOX_TABLE_WIDTH)
      expect(diagnostics.hasComplexScriptOutput).toBe(false)
      expect(diagnostics.hasWebgl).toBe(await expectAutoWebgl(orcaPage))
      expect(diagnostics.cursorHidden).toBe(false)
      expect(overpaint.offenders).toEqual([])
      expect(wrapDiagnostics.wrappedBoxLines).toEqual([])
      expect(wrapDiagnostics.wrappedSingerContinuationLines).toEqual([])
      expect(singerGeometry.rowRight).toBeLessThanOrEqual(singerGeometry.screenRight + 1)
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
