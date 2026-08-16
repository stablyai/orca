import type { Page } from '@stablyai/playwright-test'
import { existsSync } from 'node:fs'
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
import {
  collectCodexEchoLatencyReport,
  formatDistribution,
  installCodexEchoLatencyProbe,
  summarizeLatencies
} from './codex-composer-echo-latency-probe'

// Why: only the live composer draws this status bar. Banner text like "OpenAI's
// command-line coding agent" also renders on the sign-in screen, and the
// serialized buffer interleaves ANSI codes through the banner glyphs.
const CODEX_COMPOSER_READY_RE = /Context \d+% used/i
const CODEX_SIGN_IN_RE = /Sign in with ChatGPT|Sign in to|press Enter to log in/i
const CODEX_TRUST_PROMPT_RE = /Do you trust|trust this folder|Trust this/i
const CODEX_UPDATE_PROMPT_RE = /update available|install update|Skip for now/i
// Why lowercase ASCII only: digits/punctuation trigger the composer's slash and
// file-mention popups, which redraw the whole pane and skew later keystrokes.
const TYPING_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'
const TOTAL_KEYSTROKES = 60
// Why: the first keystrokes pay one-time costs (composer first-paint, WebGL
// atlas fill), so they measure startup rather than steady-state typing.
const WARMUP_KEYSTROKES = 10
const KEYSTROKE_INTERVAL_MS = 60
const TERMINAL_DUMP_CHARS = 4_000
// Why these budgets: ~20 local runs put p50 in a tight 21.5-22.6ms band with a
// unimodal per-key distribution and rare isolated spikes to ~90ms. p50 gates the
// steady state at ~1.6x observed; the tail budgets absorb those spikes so only a
// sustained shift fails. A plain-shell control on this same probe reads p50 2ms,
// so the ~22ms is Codex composer redraw cost, not harness overhead.
const MAX_P50_ECHO_LATENCY_MS = 35
const MAX_P95_ECHO_LATENCY_MS = 80
const MAX_WORST_ECHO_LATENCY_MS = 150

type CodexCursorBlinkSample = {
  elapsedMs: number
  paintedCursorCellCount: number
}

// Why the focus assert: a run that types into an unfocused pane records zero
// echoes and would otherwise fail as an opaque "sample count" mismatch.
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
    if (document.activeElement !== textarea) {
      throw new Error(
        'Terminal helper textarea did not take focus; keystrokes would not reach Codex'
      )
    }
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
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const content = await getTerminalContent(page, TERMINAL_DUMP_CHARS)
    if (CODEX_COMPOSER_READY_RE.test(content)) {
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

// Why the dump: a run that "went ready" on the sign-in screen produced garbage
// numbers silently before; failures must show what the pane actually rendered.
async function waitForCodexComposer(page: Page): Promise<string> {
  const deadline = Date.now() + 60_000
  let lastContent = ''
  while (Date.now() < deadline) {
    lastContent = await getTerminalContent(page, TERMINAL_DUMP_CHARS)
    const readyMarker = CODEX_COMPOSER_READY_RE.exec(lastContent)
    if (readyMarker) {
      return readyMarker[0]
    }
    await page.waitForTimeout(250)
  }
  const reason = CODEX_SIGN_IN_RE.test(lastContent)
    ? 'Codex stopped on the sign-in screen — CODEX_HOME auth was not visible to the TUI'
    : 'Codex never reached the composer'
  throw new Error(`${reason}\n--- terminal tail ---\n${lastContent.slice(-1_500)}\n--- end ---`)
}

test.describe('local Codex terminal typing latency', () => {
  test('keeps Codex prompt typing responsive @local-real-codex', async ({ orcaPage }, testInfo) => {
    test.skip(
      process.env.ORCA_E2E_REAL_CODEX !== '1',
      'Set ORCA_E2E_REAL_CODEX=1 to exercise the locally installed Codex TUI'
    )
    test.skip(process.platform === 'win32', 'local Codex command is POSIX-shell oriented')

    const homeDir = process.env.HOME ?? ''
    const codexSource = path.join(homeDir, 'projects', 'codex')
    // Why: the E2E profile runs an isolated HOME with a managed CODEX_HOME that
    // has no auth.json, so an unpinned launch lands on the sign-in screen.
    const realCodexHome = path.join(homeDir, '.codex')
    test.skip(
      !existsSync(path.join(realCodexHome, 'auth.json')),
      'Codex auth.json is missing; the TUI would render the sign-in screen instead of a composer'
    )
    test.skip(!existsSync(codexSource), 'local Codex checkout is missing')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const launchCommand =
      `cd ${JSON.stringify(codexSource)} && CODEX_HOME=${JSON.stringify(realCodexHome)} ` +
      'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust\r'

    try {
      await sendToTerminal(orcaPage, ptyId, launchCommand)
      await dismissCodexPromptsIfPresent(orcaPage)
      const composerMarker = await waitForCodexComposer(orcaPage)
      testInfo.annotations.push({
        type: 'codex-composer-ready-marker',
        description: composerMarker
      })
      await focusActiveTerminalInput(orcaPage)
      await forceCursorProbeTheme(orcaPage)
      const blinkSamples = await sampleCursorBlink(orcaPage)
      await focusActiveTerminalInput(orcaPage)

      const typed = Array.from(
        { length: TOTAL_KEYSTROKES },
        (_value, index) => TYPING_ALPHABET[index % TYPING_ALPHABET.length]
      ).join('')
      await installCodexEchoLatencyProbe(orcaPage, typed)
      for (const char of typed) {
        await orcaPage.keyboard.type(char)
        // Why: spacing keys past one frame keeps each sample an isolated echo
        // instead of measuring a burst the scheduler coalesced into one write.
        await orcaPage.waitForTimeout(KEYSTROKE_INTERVAL_MS)
      }
      // Why: the last keystroke's echo can still be in flight when typing ends.
      await orcaPage.waitForTimeout(1_000)
      const report = await collectCodexEchoLatencyReport(orcaPage)

      const measured = report.samples.filter((sample) => sample.index >= WARMUP_KEYSTROKES)
      const parseLatencies = measured.map((sample) => sample.keyToParseMs)
      const renderLatencies = measured
        .map((sample) => sample.keyToRenderMs)
        .filter((value): value is number => value !== null)
      const echo = summarizeLatencies(parseLatencies)
      const painted = summarizeLatencies(renderLatencies)

      const summary =
        `${formatDistribution('echo(key->parse)', echo)} | ` +
        `${formatDistribution('paint(key->render)', painted)} | ` +
        `keys=${report.keysObserved} parseEvents=${report.parseEvents}`
      testInfo.annotations.push({ type: 'codex-local-typing-latency', description: summary })
      // Why stdout too: annotations are invisible in the default list reporter,
      // and these numbers are the whole point of the run.
      console.log(`[codex-typing-latency] ready="${composerMarker}" ${summary}`)
      testInfo.annotations.push({
        type: 'codex-local-cursor-blink',
        description: blinkSamples
          .map((sample) => `${sample.elapsedMs.toFixed(0)}ms:${sample.paintedCursorCellCount}`)
          .join(',')
      })

      expect(blinkSamples.some((sample) => sample.paintedCursorCellCount > 0)).toBe(true)
      expect(blinkSamples.some((sample) => sample.paintedCursorCellCount === 0)).toBe(true)
      // Why: a dropped keystroke means the composer stopped echoing, which the
      // latency percentiles alone would silently hide.
      expect(report.samples.length).toBe(TOTAL_KEYSTROKES)
      expect(echo.p50).toBeLessThan(MAX_P50_ECHO_LATENCY_MS)
      expect(echo.p95).toBeLessThan(MAX_P95_ECHO_LATENCY_MS)
      expect(echo.max).toBeLessThan(MAX_WORST_ECHO_LATENCY_MS)
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
})
