import type { Page } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  analyzeRasterCursorCells,
  type TerminalRasterProbeTarget
} from './terminal-cursor-raster-probe'

const CODEX_READY_RE = /Ask Codex|OpenAI/i
const CODEX_TRUST_PROMPT_RE = /Do you trust|trust this folder|Trust this/i
const CODEX_UPDATE_PROMPT_RE = /update available|install update|Skip for now/i
const MAX_MEDIAN_KEY_LATENCY_MS = 150
const MAX_WORST_KEY_LATENCY_MS = 500

type CodexCursorBlinkSample = {
  elapsedMs: number
  paintedCursorCellCount: number
}

async function focusActiveTerminalInput(page: Page): Promise<void> {
  await page.evaluate(() => {
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
    const textarea = pane?.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!pane || !textarea) {
      throw new Error('Active terminal input is unavailable')
    }
    pane.terminal.focus()
    textarea.focus()
  })
}

async function forceCursorProbeTheme(page: Page): Promise<void> {
  await page.evaluate(() => {
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
    if (!pane) {
      throw new Error('Active terminal pane is unavailable')
    }
    pane.terminal.options.cursorStyle = 'block'
    pane.terminal.options.cursorBlink = true
    pane.terminal.options.theme = {
      ...pane.terminal.options.theme,
      cursor: '#23ff45',
      cursorAccent: '#001000'
    }
    pane.terminal.focus()
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  })
}

async function readActiveTerminalRasterTarget(page: Page): Promise<TerminalRasterProbeTarget> {
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
    const screen = pane?.container.querySelector<HTMLElement>('.xterm-screen')
    const dimensions = pane?.terminal._core?._renderService?.dimensions?.css?.cell
    if (!pane || !screen || !dimensions) {
      throw new Error('Active terminal screen is unavailable')
    }
    const rect = screen.getBoundingClientRect()
    return {
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      cellWidth: dimensions.width,
      cellHeight: dimensions.height,
      rows: pane.terminal.rows,
      cols: pane.terminal.cols
    }
  })
}

async function sampleCursorBlink(page: Page): Promise<CodexCursorBlinkSample[]> {
  const samples: CodexCursorBlinkSample[] = []
  const target = await readActiveTerminalRasterTarget(page)
  const viewport = page.viewportSize() ?? undefined
  const start = performance.now()
  for (let index = 0; index < 9; index += 1) {
    if (index > 0) {
      await page.waitForTimeout(200)
    }
    const screenshot = await page.screenshot()
    const cells = analyzeRasterCursorCells(Buffer.from(screenshot), target, viewport)
    samples.push({
      elapsedMs: performance.now() - start,
      paintedCursorCellCount: cells.length
    })
  }
  return samples
}

async function dismissCodexPromptsIfPresent(page: Page): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const content = await getTerminalContent(page, 12_000)
    if (CODEX_READY_RE.test(content) && !CODEX_TRUST_PROMPT_RE.test(content)) {
      return
    }
    if (CODEX_TRUST_PROMPT_RE.test(content)) {
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      continue
    }
    if (CODEX_UPDATE_PROMPT_RE.test(content)) {
      await page.keyboard.type('3')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      continue
    }
    await page.waitForTimeout(250)
  }
}

async function waitForCodexReady(page: Page): Promise<void> {
  await expect
    .poll(async () => CODEX_READY_RE.test(await getTerminalContent(page, 12_000)), {
      timeout: 45_000,
      message: 'Codex TUI did not render'
    })
    .toBe(true)
}

async function waitForPromptText(page: Page, text: string): Promise<number> {
  const start = performance.now()
  while (performance.now() - start < MAX_WORST_KEY_LATENCY_MS) {
    if ((await getTerminalContent(page, 12_000)).includes(text)) {
      return performance.now() - start
    }
    await page.waitForTimeout(5)
  }
  throw new Error(`Codex prompt did not show ${text}`)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

test.describe('local Codex terminal typing latency', () => {
  test('keeps Codex prompt typing responsive @local-real-codex', async ({ orcaPage }, testInfo) => {
    test.skip(
      process.env.ORCA_E2E_REAL_CODEX !== '1',
      'Set ORCA_E2E_REAL_CODEX=1 to exercise the locally installed Codex TUI'
    )
    test.skip(process.platform === 'win32', 'local Codex command is POSIX-shell oriented')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const codexSource = path.join(process.env.HOME ?? '', 'projects', 'codex')
    const launchCommand =
      `cd ${JSON.stringify(codexSource)} && ` +
      'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust\r'

    try {
      await sendToTerminal(orcaPage, ptyId, launchCommand)
      await dismissCodexPromptsIfPresent(orcaPage)
      await waitForCodexReady(orcaPage)
      await focusActiveTerminalInput(orcaPage)
      await forceCursorProbeTheme(orcaPage)
      const blinkSamples = await sampleCursorBlink(orcaPage)

      const runId = randomUUID().replaceAll('-', '').slice(0, 8)
      const prompt = `orca_codex_latency_${runId}`
      const latencies: number[] = []
      let typed = ''
      for (const char of prompt) {
        typed += char
        const start = performance.now()
        await orcaPage.keyboard.type(char)
        await waitForPromptText(orcaPage, typed)
        latencies.push(performance.now() - start)
      }

      const medianLatency = median(latencies)
      const worstLatency = Math.max(...latencies)
      testInfo.annotations.push({
        type: 'codex-local-typing-latency',
        description: `median=${medianLatency.toFixed(1)}ms worst=${worstLatency.toFixed(
          1
        )}ms samples=${latencies.map((value) => value.toFixed(1)).join(',')}`
      })
      testInfo.annotations.push({
        type: 'codex-local-cursor-blink',
        description: blinkSamples
          .map((sample) => `${sample.elapsedMs.toFixed(0)}ms:${sample.paintedCursorCellCount}`)
          .join(',')
      })

      expect(blinkSamples.some((sample) => sample.paintedCursorCellCount > 0)).toBe(true)
      expect(blinkSamples.some((sample) => sample.paintedCursorCellCount === 0)).toBe(true)
      expect(medianLatency).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
      expect(worstLatency).toBeLessThan(MAX_WORST_KEY_LATENCY_MS)
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
})
