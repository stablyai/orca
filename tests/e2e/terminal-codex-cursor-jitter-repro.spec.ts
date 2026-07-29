import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'
import { analyzeRasterCursorCells, type RasterCursorCell } from './terminal-cursor-raster-probe'

type ShellCase = {
  label: string
  shellOverride: 'powershell.exe' | 'cmd.exe' | 'wsl.exe'
  codexCommand: string
}

type CaptureTarget = {
  tabId: string
  ptyId: string
  clip: { x: number; y: number; width: number; height: number }
  cellWidth: number
  cellHeight: number
  rows: number
  cols: number
  cursorX: number
  cursorY: number
  suppressed: boolean
  renderer: 'webgl' | 'dom'
  windowsPty: { backend?: string; buildNumber?: number } | null
  marker: CursorMarker | null
  cursorDebug: CursorDebug
}

type CursorMarker = {
  pixelCount: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  centerX: number
  centerY: number
  cellX: number
  cellY: number
}

type CursorDebug = {
  cursorCount: number
  cursorLayerCount: number
  cursorCanvasCount: number
  firstCursorClass: string
  firstCursorDisplay: string
  firstCursorVisibility: string
  firstCursorOpacity: string
  firstCursorRect: { x: number; y: number; width: number; height: number } | null
  coreCursorHidden: boolean | null
  coreCursorInitialized: boolean | null
  terminalKeys: string[]
  terminalPrototypeKeys: string[]
}

type TerminalWithInternalCore = {
  _core?: {
    coreService?: {
      isCursorHidden: boolean
      isCursorInitialized: boolean
    }
  }
}

type ScreenSnapshot = {
  label: string
  cursorX: number
  cursorY: number
  coreCursorHidden: boolean | null
  suppressed: boolean
  renderer: 'webgl' | 'dom'
  marker: CursorMarker | null
  windowsPty: { backend?: string; buildNumber?: number } | null
  lines: { row: number; text: string }[]
}

type QueuedMessageFrame = ScreenSnapshot & {
  index: number
  at: number
  elapsedMs: number
  rasterCursorCells: RasterCursorCell[]
  rasterWorkingCursorCells: RasterCursorCell[]
  rasterNonInputCursorCells: RasterCursorCell[]
}

type RasterFrameInput = {
  buffer: Buffer
  at: number
  elapsedMs: number
}

type CursorReproWindow = Window & {
  __cursorReproOriginalPtyWrite?: (ptyId: string, data: string) => void
  __cursorReproConptyDa1ReplyCount?: number
  __cursorReproRawChunks?: { id: string; data: string; at: number }[]
  __cursorReproRawUnsubscribe?: () => void
}

const CURSOR_THEME = {
  cursor: '#23ff45',
  cursorAccent: '#001000',
  foreground: '#f4f4f5',
  background: '#050505',
  green: '#44aa66',
  brightGreen: '#58c979'
}

const CODEX_TUI_READY_RE = /Ask Codex|OpenAI/i
const CODEX_TRUST_PROMPT_RE = /Do you trust the contents of this directory\?/i
const CODEX_UPDATE_PROMPT_RE = /Update available|Skip until next version/i
const CODEX_WORKING_STATUS_RE =
  /W[\s\S]{0,20}o[\s\S]{0,20}r[\s\S]{0,20}k[\s\S]{0,20}i[\s\S]{0,20}n[\s\S]{0,20}g[\s\S]{0,40}\(/i
const QUEUED_CURSOR_SAMPLE_INTERVAL_MS = 5
const QUEUED_CURSOR_CAPTURE_MS = 6_000
const ARTIFACT_DIR = path.join(process.cwd(), '.tmp', 'cursor-jitter-repro')
const CONPTY_DA1_RESPONSE = '\x1b[?61;4c'
const CODEX_REPO_PROMPT = 'tell me about this repo'

const SHELL_CASES: ShellCase[] = [
  {
    label: 'powershell-codex-attempt-1',
    shellOverride: 'powershell.exe',
    codexCommand: 'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust'
  }
]

function isVisibleWorkingCursorFrame(frame: ScreenSnapshot): boolean {
  if (!frame.marker || frame.coreCursorHidden !== false) {
    return false
  }
  const cursorLine = frame.lines.find((line) => line.row === frame.cursorY)?.text ?? ''
  return /Working/i.test(cursorLine)
}

function workingRows(snapshot: ScreenSnapshot): Set<number> {
  return new Set(
    snapshot.lines.filter((line) => /Working/i.test(line.text)).map((line) => line.row)
  )
}

function isQueuedInputLine(text: string): boolean {
  return (
    /\bs\b/.test(text) &&
    (text.includes('>') || text.includes('›') || text.includes('\u00e2\u20ac\u00ba'))
  )
}

function isInputCursorRow(snapshot: ScreenSnapshot, row: number): boolean {
  const text = snapshot.lines.find((line) => line.row === row)?.text ?? ''
  const trimmed = text.trimStart()
  return isQueuedInputLine(text) || trimmed.startsWith('›')
}

function isPromptCursorFrame(frame: ScreenSnapshot): boolean {
  if (!frame.marker || frame.coreCursorHidden !== false) {
    return false
  }
  return isInputCursorRow(frame, frame.marker.cellY)
}

function isUnexpectedVisibleCursorFrame(frame: ScreenSnapshot): boolean {
  if (!frame.marker || frame.coreCursorHidden !== false) {
    return false
  }
  return !isInputCursorRow(frame, frame.marker.cellY)
}

function quotePowerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function createShellTab(
  page: Page,
  shellOverride: ShellCase['shellOverride']
): Promise<string> {
  return page.evaluate((shellOverride) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }
    store.setState({
      settings: { ...state.settings!, terminalWindowsShell: shellOverride }
    })
    const tab = store.getState().createTab(worktreeId, undefined, shellOverride, {
      activate: true
    })
    store.getState().setActiveTab(tab.id)
    return tab.id
  }, shellOverride)
}

async function waitForTabPanePtyId(page: Page, tabId: string, timeoutMs: number): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return activePane?.container?.dataset?.ptyId ?? null
        }, tabId),
      {
        timeout: timeoutMs,
        message: `Terminal pane did not receive a PTY binding for tab ${tabId}`
      }
    )
    .not.toBeNull()

  const ptyId = await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return activePane?.container?.dataset?.ptyId ?? null
  }, tabId)
  if (!ptyId) {
    throw new Error(`Terminal pane lost PTY binding for tab ${tabId}`)
  }
  return ptyId
}

async function getTerminalContentForTab(
  page: Page,
  tabId: string,
  charLimit: number
): Promise<string> {
  return page.evaluate(
    ({ tabId, charLimit }) => {
      const manager = window.__paneManagers?.get(tabId)
      const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const text = activePane?.serializeAddon?.serialize?.() ?? ''
      return text.slice(-charLimit)
    },
    { tabId, charLimit }
  )
}

async function prepareCodexTerminal(
  page: Page,
  shellCase: ShellCase
): Promise<{ tabId: string; ptyId: string }> {
  const tabId = await createShellTab(page, shellCase.shellOverride)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForTabPanePtyId(page, tabId, 30_000)
  await applyCursorProbeTheme(page, tabId)

  const launchCommand =
    shellCase.shellOverride === 'powershell.exe'
      ? `Set-Location -LiteralPath ${quotePowerShellSingleQuoted(process.cwd())}; ${shellCase.codexCommand}`
      : shellCase.codexCommand
  await page.keyboard.insertText(launchCommand)
  await page.keyboard.press('Enter')
  await dismissCodexTrustPromptIfPresent(page, tabId)
  await dismissCodexUpdatePromptIfPresent(page, tabId)
  try {
    await expect
      .poll(
        async () => CODEX_TUI_READY_RE.test(await getTerminalContentForTab(page, tabId, 8_000)),
        {
          timeout: 45_000,
          message: `${shellCase.label} Codex TUI did not render`
        }
      )
      .toBe(true)
  } catch (error) {
    writeFileSync(
      path.join(ARTIFACT_DIR, `${shellCase.label}-codex-launch-terminal.txt`),
      await getTerminalContentForTab(page, tabId, 12_000)
    )
    throw error
  }
  await applyCursorProbeTheme(page, tabId)
  return { tabId, ptyId }
}

async function dismissCodexTrustPromptIfPresent(page: Page, tabId: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const content = await getTerminalContentForTab(page, tabId, 8_000)
    if (CODEX_TUI_READY_RE.test(content) && !CODEX_TRUST_PROMPT_RE.test(content)) {
      return
    }
    if (CODEX_TRUST_PROMPT_RE.test(content)) {
      await page.keyboard.press('Enter')
      return
    }
    await page.waitForTimeout(250)
  }
}

async function installPtyWriteDiagnostics(page: Page): Promise<void> {
  await page.evaluate((da1Response) => {
    const reproWindow = window as CursorReproWindow
    if (!reproWindow.__cursorReproOriginalPtyWrite) {
      reproWindow.__cursorReproOriginalPtyWrite = window.api.pty.write.bind(window.api.pty)
      window.api.pty.write = (ptyId, data) => {
        if (data === da1Response) {
          reproWindow.__cursorReproConptyDa1ReplyCount =
            (reproWindow.__cursorReproConptyDa1ReplyCount ?? 0) + 1
        }
        reproWindow.__cursorReproOriginalPtyWrite!(ptyId, data)
      }
    }
    reproWindow.__cursorReproConptyDa1ReplyCount = 0
  }, CONPTY_DA1_RESPONSE)
}

async function installPtyOutputDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const reproWindow = window as CursorReproWindow
    reproWindow.__cursorReproRawUnsubscribe?.()
    reproWindow.__cursorReproRawChunks = []
    reproWindow.__cursorReproRawUnsubscribe = window.api.pty.onData((payload) => {
      reproWindow.__cursorReproRawChunks!.push({
        id: payload.id,
        data: payload.data,
        at: Date.now()
      })
      if (reproWindow.__cursorReproRawChunks!.length > 2_000) {
        reproWindow.__cursorReproRawChunks!.shift()
      }
    })
  })
}

async function readPtyOutputDiagnostics(
  page: Page
): Promise<{ id: string; data: string; at: number }[]> {
  return page.evaluate(() => {
    const reproWindow = window as CursorReproWindow
    return reproWindow.__cursorReproRawChunks ?? []
  })
}

async function readScreenSnapshot(
  page: Page,
  label: string,
  tabId: string,
  ptyId: string
): Promise<ScreenSnapshot> {
  const target = await readCaptureTarget(page, tabId, ptyId)
  const lines = await readScreenLines(page, tabId)

  return {
    label,
    cursorX: target.cursorX,
    cursorY: target.cursorY,
    coreCursorHidden: target.cursorDebug.coreCursorHidden,
    suppressed: target.suppressed,
    renderer: target.renderer,
    marker: target.marker,
    windowsPty: target.windowsPty,
    lines
  }
}

async function readScreenLines(
  page: Page,
  tabId: string
): Promise<{ row: number; text: string }[]> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error(`No active pane for tab ${tabId}`)
    }
    const terminal = pane.terminal
    const result: { row: number; text: string }[] = []
    const viewportY = terminal.buffer.active.viewportY
    for (let row = 0; row < terminal.rows; row += 1) {
      const text = terminal.buffer.active.getLine(viewportY + row)?.translateToString(true) ?? ''
      if (text.trim()) {
        result.push({ row, text })
      }
    }
    return result
  }, tabId)
}

function escapePtyChunk(data: string): string {
  return data
    .split('\u001b')
    .join('\\e')
    .split('\r')
    .join('\\r')
    .split('\n')
    .join('\\n')
    .split('\u0007')
    .join('\\a')
}

function formatPtyChunks(chunks: { data: string; at: number }[]): string {
  const startedAt = chunks[0]?.at ?? 0
  return chunks
    .map(
      (chunk, index) =>
        `@${chunk.at} +${chunk.at - startedAt}ms chunk ${index}\n${escapePtyChunk(chunk.data)}`
    )
    .join('\n--- chunk ---\n')
}

async function dismissCodexUpdatePromptIfPresent(page: Page, tabId: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const content = await getTerminalContentForTab(page, tabId, 8_000)
    if (CODEX_TUI_READY_RE.test(content) && !CODEX_UPDATE_PROMPT_RE.test(content)) {
      return
    }
    if (CODEX_UPDATE_PROMPT_RE.test(content)) {
      await page.keyboard.type('3')
      await page.keyboard.press('Enter')
      return
    }
    await page.waitForTimeout(250)
  }
}

async function applyCursorProbeTheme(page: Page, tabId: string): Promise<void> {
  await page.evaluate(
    ({ tabId, theme }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error(`No active pane for tab ${tabId}`)
      }
      pane.terminal.options.cursorStyle = 'bar'
      pane.terminal.options.cursorBlink = true
      pane.terminal.options.theme = {
        ...pane.terminal.options.theme,
        ...theme
      }
      pane.terminal.refresh(0, pane.terminal.rows - 1)
      pane.terminal.focus()
    },
    { tabId, theme: CURSOR_THEME }
  )
}

async function readCaptureTarget(page: Page, tabId: string, ptyId: string): Promise<CaptureTarget> {
  return page.evaluate(
    ({ tabId, ptyId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error(`No active pane for tab ${tabId}`)
      }
      const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) {
        throw new Error('xterm screen element not found')
      }
      const rect = screen.getBoundingClientRect()
      const terminal = pane.terminal
      const terminalCore = (terminal as unknown as TerminalWithInternalCore)._core
      const cellWidth = rect.width / terminal.cols
      const cellHeight = rect.height / terminal.rows
      const cursorElement = pane.container.querySelector<HTMLElement>('.xterm-cursor')
      const cursorRect = cursorElement?.getBoundingClientRect()
      const cursorStyle = cursorElement ? window.getComputedStyle(cursorElement) : null
      const cursorVisible =
        !!cursorElement &&
        !!cursorRect &&
        cursorRect.width > 0 &&
        cursorRect.height > 0 &&
        cursorStyle?.display !== 'none' &&
        cursorStyle?.visibility !== 'hidden' &&
        Number(cursorStyle?.opacity ?? '1') > 0
      const marker =
        cursorVisible && cursorRect
          ? {
              pixelCount: Math.max(1, Math.round(cursorRect.width * cursorRect.height)),
              minX: cursorRect.left - rect.left,
              minY: cursorRect.top - rect.top,
              maxX: cursorRect.right - rect.left,
              maxY: cursorRect.bottom - rect.top,
              centerX: cursorRect.left - rect.left + cursorRect.width / 2,
              centerY: cursorRect.top - rect.top + cursorRect.height / 2,
              cellX: Math.max(0, Math.floor((cursorRect.left - rect.left) / cellWidth)),
              cellY: Math.max(0, Math.floor((cursorRect.top - rect.top) / cellHeight))
            }
          : null
      const cursorCanvas = pane.container.querySelector<HTMLCanvasElement>(
        '.xterm-cursor-layer canvas'
      )
      const canvasLayer = cursorCanvas?.closest<HTMLElement>('.xterm-cursor-layer')
      const canvasLayerStyle = canvasLayer ? window.getComputedStyle(canvasLayer) : null
      const canvasMarker = (() => {
        if (
          !cursorCanvas ||
          canvasLayerStyle?.display === 'none' ||
          canvasLayerStyle?.visibility === 'hidden'
        ) {
          return null
        }
        const context = cursorCanvas.getContext('2d', { willReadFrequently: true })
        if (!context) {
          return null
        }
        const image = context.getImageData(0, 0, cursorCanvas.width, cursorCanvas.height)
        let pixelCount = 0
        let minX = Number.POSITIVE_INFINITY
        let minY = Number.POSITIVE_INFINITY
        let maxX = 0
        let maxY = 0
        let sumX = 0
        let sumY = 0
        for (let y = 0; y < cursorCanvas.height; y += 1) {
          for (let x = 0; x < cursorCanvas.width; x += 1) {
            const offset = (y * cursorCanvas.width + x) * 4
            const red = image.data[offset] ?? 0
            const green = image.data[offset + 1] ?? 0
            const blue = image.data[offset + 2] ?? 0
            const alpha = image.data[offset + 3] ?? 0
            if (red < 180 || green > 100 || blue < 180 || alpha < 120) {
              continue
            }
            pixelCount += 1
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
            sumX += x
            sumY += y
          }
        }
        if (pixelCount < 4) {
          return null
        }
        const canvasCellWidth = cursorCanvas.width / terminal.cols
        const canvasCellHeight = cursorCanvas.height / terminal.rows
        const centerX = sumX / pixelCount
        const centerY = sumY / pixelCount
        return {
          pixelCount,
          minX,
          minY,
          maxX,
          maxY,
          centerX,
          centerY,
          cellX: Math.max(0, Math.floor(centerX / canvasCellWidth)),
          cellY: Math.max(0, Math.floor(centerY / canvasCellHeight))
        }
      })()
      return {
        tabId,
        ptyId,
        clip: {
          x: Math.floor(rect.x),
          y: Math.floor(rect.y),
          width: Math.max(1, Math.floor(rect.width)),
          height: Math.max(1, Math.floor(rect.height))
        },
        cellWidth,
        cellHeight,
        rows: terminal.rows,
        cols: terminal.cols,
        cursorX: terminal.buffer.active.cursorX,
        cursorY: terminal.buffer.active.cursorY,
        suppressed: false,
        renderer: pane.webglAddon ? 'webgl' : 'dom',
        windowsPty: (terminal.options.windowsPty ?? null) as {
          backend?: string
          buildNumber?: number
        } | null,
        marker: marker ?? canvasMarker,
        cursorDebug: {
          cursorCount: pane.container.querySelectorAll('.xterm-cursor').length,
          cursorLayerCount: pane.container.querySelectorAll('.xterm-cursor-layer').length,
          cursorCanvasCount: pane.container.querySelectorAll('.xterm-cursor-layer canvas').length,
          firstCursorClass: cursorElement?.className ?? '',
          firstCursorDisplay: cursorStyle?.display ?? '',
          firstCursorVisibility: cursorStyle?.visibility ?? '',
          firstCursorOpacity: cursorStyle?.opacity ?? '',
          firstCursorRect: cursorRect
            ? {
                x: cursorRect.x,
                y: cursorRect.y,
                width: cursorRect.width,
                height: cursorRect.height
              }
            : null,
          coreCursorHidden: terminalCore?.coreService?.isCursorHidden ?? null,
          coreCursorInitialized: terminalCore?.coreService?.isCursorInitialized ?? null,
          terminalKeys: Object.keys(terminal).slice(0, 20),
          terminalPrototypeKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(terminal)).slice(
            0,
            30
          )
        }
      }
    },
    { tabId, ptyId }
  )
}

async function captureQueuedMessageFrames(
  page: Page,
  label: string,
  tabId: string,
  ptyId: string,
  testInfo: TestInfo
): Promise<QueuedMessageFrame[]> {
  const target = await readCaptureTarget(page, tabId, ptyId)
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  const rasterInputs: RasterFrameInput[] = []
  const screenSamples: QueuedMessageFrame[] = []
  const startedAt = Date.now()
  let suspiciousScreenshotCount = 0

  const cdp = await page.context().newCDPSession(page)
  cdp.on('Page.screencastFrame', (params) => {
    rasterInputs.push({
      buffer: Buffer.from(params.data, 'base64'),
      at: Date.now(),
      elapsedMs: Date.now() - startedAt
    })
    void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  })

  await cdp.send('Page.enable').catch(() => {})
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  try {
    while (Date.now() - startedAt < QUEUED_CURSOR_CAPTURE_MS) {
      screenSamples.push({
        ...(await readScreenSnapshot(page, label, tabId, ptyId)),
        index: screenSamples.length,
        at: Date.now(),
        elapsedMs: Date.now() - startedAt,
        rasterCursorCells: [],
        rasterWorkingCursorCells: [],
        rasterNonInputCursorCells: []
      })
      await page.waitForTimeout(QUEUED_CURSOR_SAMPLE_INTERVAL_MS)
    }
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => {})
    await cdp.detach().catch(() => {})
  }

  const fallbackSample = screenSamples[0] ?? {
    ...(await readScreenSnapshot(page, label, tabId, ptyId)),
    index: 0,
    at: Date.now(),
    elapsedMs: Date.now() - startedAt,
    rasterCursorCells: [],
    rasterWorkingCursorCells: [],
    rasterNonInputCursorCells: []
  }
  const frames: QueuedMessageFrame[] = []
  for (const [index, input] of rasterInputs.entries()) {
    const sample = screenSamples.reduce(
      (nearest, candidate) =>
        Math.abs(candidate.elapsedMs - input.elapsedMs) <
        Math.abs(nearest.elapsedMs - input.elapsedMs)
          ? candidate
          : nearest,
      fallbackSample
    )
    const rasterCursorCells = analyzeRasterCursorCells(input.buffer, target, viewport)
    const rasterWorkingCursorCells = rasterCursorCells.filter((cell) =>
      workingRows(sample).has(cell.cellY)
    )
    const rasterNonInputCursorCells = rasterCursorCells.filter(
      (cell) => !isInputCursorRow(sample, cell.cellY)
    )
    if (
      (rasterWorkingCursorCells.length > 0 || rasterNonInputCursorCells.length > 0) &&
      suspiciousScreenshotCount < 8
    ) {
      const filename = `queued-message-raster-suspicious-cursor-${index}.png`
      await testInfo.attach(filename, {
        body: input.buffer,
        contentType: 'image/png'
      })
      writeFileSync(path.join(ARTIFACT_DIR, filename), input.buffer)
      suspiciousScreenshotCount += 1
    }
    frames.push({
      ...sample,
      index,
      at: input.at,
      elapsedMs: input.elapsedMs,
      rasterCursorCells,
      rasterWorkingCursorCells,
      rasterNonInputCursorCells
    })
  }
  return frames
}

test.describe('Codex terminal cursor jitter repro', () => {
  test('keeps queued-message cursor out of the Working status row in native Windows Codex @headful', async ({
    orcaPage
  }, testInfo) => {
    test.skip(process.platform !== 'win32', 'native Windows cursor repro only runs on Windows')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await installPtyWriteDiagnostics(orcaPage)
    rmSync(ARTIFACT_DIR, { recursive: true, force: true })
    mkdirSync(ARTIFACT_DIR, { recursive: true })

    const shellCase = SHELL_CASES[0]!
    const { tabId, ptyId } = await prepareCodexTerminal(orcaPage, shellCase)
    await installPtyOutputDiagnostics(orcaPage)
    await orcaPage.keyboard.type(CODEX_REPO_PROMPT)
    await orcaPage.waitForTimeout(250)
    await orcaPage.keyboard.press('Enter')
    await orcaPage.waitForTimeout(1_000)
    if (!CODEX_WORKING_STATUS_RE.test(await getTerminalContentForTab(orcaPage, tabId, 8_000))) {
      await orcaPage.keyboard.press('Enter')
    }
    await orcaPage.waitForTimeout(3_000)
    const submittedContent = await getTerminalContentForTab(orcaPage, tabId, 8_000)
    writeFileSync(path.join(ARTIFACT_DIR, 'queued-message-after-submit.txt'), submittedContent)
    await expect
      .poll(
        async () =>
          CODEX_WORKING_STATUS_RE.test(await getTerminalContentForTab(orcaPage, tabId, 8_000)),
        {
          timeout: 30_000,
          message: 'Codex did not enter Working state'
        }
      )
      .toBe(true)
    await applyCursorProbeTheme(orcaPage, tabId)
    const workingOnlyFrames = await captureQueuedMessageFrames(
      orcaPage,
      `${shellCase.label}-no-input`,
      tabId,
      ptyId,
      testInfo
    )
    await orcaPage.keyboard.insertText('s')
    await expect
      .poll(
        async () =>
          (await readScreenLines(orcaPage, tabId)).some((line) => isQueuedInputLine(line.text)),
        {
          timeout: 5_000,
          message: 'queued input did not appear before cursor capture'
        }
      )
      .toBe(true)
    const frames = await captureQueuedMessageFrames(
      orcaPage,
      shellCase.label,
      tabId,
      ptyId,
      testInfo
    )

    const snapshot = await readScreenSnapshot(orcaPage, shellCase.label, tabId, ptyId)
    const rawChunks = await readPtyOutputDiagnostics(orcaPage)
    const visibleWorkingOnlyCursorFrames = workingOnlyFrames.filter(isPromptCursorFrame)
    const unexpectedWorkingOnlyCursorFrames = workingOnlyFrames.filter(
      isUnexpectedVisibleCursorFrame
    )
    const visibleWorkingCursorFrames = frames.filter(isVisibleWorkingCursorFrame)
    const unexpectedQueuedCursorFrames = frames.filter(isUnexpectedVisibleCursorFrame)
    const rasterWorkingCursorFrames = frames.filter(
      (frame) => frame.rasterWorkingCursorCells.length > 0
    )
    await testInfo.attach('queued-message-cursor-frames.json', {
      body: JSON.stringify(frames, null, 2),
      contentType: 'application/json'
    })
    await testInfo.attach('working-no-input-cursor-frames.json', {
      body: JSON.stringify(workingOnlyFrames, null, 2),
      contentType: 'application/json'
    })
    await testInfo.attach('queued-message-screen.json', {
      body: JSON.stringify(snapshot, null, 2),
      contentType: 'application/json'
    })
    await testInfo.attach('queued-message-pty-chunks.txt', {
      body: formatPtyChunks(rawChunks),
      contentType: 'text/plain'
    })
    writeFileSync(
      path.join(ARTIFACT_DIR, 'queued-message-screen.json'),
      `${JSON.stringify(snapshot, null, 2)}\n`
    )
    writeFileSync(
      path.join(ARTIFACT_DIR, 'queued-message-cursor-frames.json'),
      `${JSON.stringify(frames, null, 2)}\n`
    )
    writeFileSync(
      path.join(ARTIFACT_DIR, 'working-no-input-cursor-frames.json'),
      `${JSON.stringify(workingOnlyFrames, null, 2)}\n`
    )
    writeFileSync(
      path.join(ARTIFACT_DIR, 'queued-message-pty-chunks.txt'),
      `${formatPtyChunks(rawChunks)}\n`
    )

    const queuedInputFrames = frames.filter((frame) =>
      frame.lines.some((line) => isQueuedInputLine(line.text))
    )
    expect(
      queuedInputFrames.length,
      'queued input should be captured before checking cursor placement'
    ).toBeGreaterThan(0)
    expect(
      visibleWorkingOnlyCursorFrames,
      'Codex should expose its prompt cursor during the no-input capture so the repro can detect misplaced cursor restores'
    ).not.toEqual([])
    expect(
      unexpectedWorkingOnlyCursorFrames,
      `visible cursor should only appear on Codex prompt rows while Working: ${JSON.stringify(unexpectedWorkingOnlyCursorFrames)}`
    ).toEqual([])
    expect(
      visibleWorkingCursorFrames,
      `cursor should not be visibly parked on Working row: ${JSON.stringify(visibleWorkingCursorFrames)}`
    ).toEqual([])
    expect(
      rasterWorkingCursorFrames,
      `rasterized terminal should not paint cursor-colored pixels on Working row: ${JSON.stringify(rasterWorkingCursorFrames)}`
    ).toEqual([])
    expect(
      unexpectedQueuedCursorFrames,
      `visible cursor should only appear on Codex prompt rows after queuing input: ${JSON.stringify(unexpectedQueuedCursorFrames)}`
    ).toEqual([])
  })
})
