import type { Page } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
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
import {
  attachTerminalImeBoundaryEvidence,
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'

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
const TWO_SET_KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'
const KOREAN_TUI_TEXT = '가나다라마바사아자차카타파하'
const KOREAN_TUI_REPETITIONS = 5
const KOREAN_TUI_EXPECTED = KOREAN_TUI_TEXT.repeat(KOREAN_TUI_REPETITIONS)
const ESC = String.fromCharCode(27)
const KEY_RELEASE_REPORT_RE = new RegExp(`${ESC}\\[\\d+;1:3u`, 'g')
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const KOREAN_TUI_KEY_CODES = [
  15, 40, 1, 40, 14, 40, 3, 40, 0, 40, 12, 40, 17, 40, 2, 40, 13, 40, 8, 40, 6, 40, 7, 40, 9, 40
]
const KOREAN_TUI_REMAINING_KEY_CODES = Array.from({ length: KOREAN_TUI_REPETITIONS - 1 }, () => [
  ...KOREAN_TUI_KEY_CODES,
  5,
  40
]).flat()

type CodexCursorBlinkSample = {
  elapsedMs: number
  paintedCursorCellCount: number
}

function typeNativeKorean(keyCodes: readonly number[]): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to key code {${keyCodes.join(', ')}}`
  ])
}

function focusApplication(processId: number): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`
  ])
}

async function readActiveComposition(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    const composition = textarea?.parentElement?.querySelector<HTMLElement>(
      '.composition-view.active'
    )
    return composition?.textContent?.replaceAll('\u200e', '') ?? null
  })
}

function stripKeyReleaseReports(data: string): string {
  return data.replace(KEY_RELEASE_REPORT_RE, '')
}

function stripCsi(data: string): string {
  return data.replace(CSI_RE, '')
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

      const inputLatencies = report.dataSamples
        .filter((sample) => sample.index >= WARMUP_KEYSTROKES)
        .map((sample) => sample.keyToDataMs)
      const input = summarizeLatencies(inputLatencies)
      const summary =
        `${formatDistribution('echo(key->parse)', echo)} | ` +
        `${formatDistribution('paint(key->render)', painted)} | ` +
        `${formatDistribution('input(key->onData)', input)} | ` +
        `keys=${report.keysObserved} parseEvents=${report.parseEvents} ` +
        `dataSamples=${report.dataSamples.length} dataEvents=${report.dataEvents} ` +
        `unattributedData=${report.unattributedDataEvents} imeKeys=${report.imeKeysObserved} ` +
        `inputMeasured=${inputLatencies.length}`
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
      // Why counts before percentiles on the input arm too: an unhooked `onData`
      // records nothing, and a distribution over nothing reads as perfect latency.
      expect(report.dataSamples.length).toBe(TOTAL_KEYSTROKES)
      expect(input.count).toBe(TOTAL_KEYSTROKES - WARMUP_KEYSTROKES)
      expect(echo.p50).toBeLessThan(MAX_P50_ECHO_LATENCY_MS)
      expect(echo.p95).toBeLessThan(MAX_P95_ECHO_LATENCY_MS)
      expect(echo.max).toBeLessThan(MAX_WORST_ECHO_LATENCY_MS)
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })

  test('preserves native Korean composition in the Codex prompt @headful', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    test.skip(
      process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_KOREAN !== '1',
      'Requires macOS with 2-Set Korean selected and Accessibility access'
    )
    test.skip(
      process.env.ORCA_E2E_REAL_CODEX !== '1',
      'Set ORCA_E2E_REAL_CODEX=1 to exercise the locally installed Codex TUI'
    )

    const homeDir = process.env.HOME ?? ''
    const codexSource = path.join(homeDir, 'projects', 'codex')
    const realCodexHome = path.join(homeDir, '.codex')
    test.skip(!existsSync(path.join(realCodexHome, 'auth.json')), 'Codex auth.json is missing')
    test.skip(!existsSync(codexSource), 'local Codex checkout is missing')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expect(orcaPage.evaluate(() => window.api.app.getKeyboardInputSourceId())).resolves.toBe(
      TWO_SET_KOREAN_ID
    )

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const launchCommand =
      `cd ${JSON.stringify(codexSource)} && CODEX_HOME=${JSON.stringify(realCodexHome)} ` +
      'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust\r'

    try {
      await sendToTerminal(orcaPage, ptyId, launchCommand)
      await dismissCodexPromptsIfPresent(orcaPage)
      await waitForCodexComposer(orcaPage)
      await focusActiveTerminalInput(orcaPage)
      focusApplication(electronApp.process().pid!)
      await orcaPage.waitForTimeout(300)
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)
      typeNativeKorean(KOREAN_TUI_KEY_CODES)
      typeNativeKorean([5])
      await expect.poll(() => readActiveComposition(orcaPage)).toBe('팧')
      typeNativeKorean([40])
      await expect.poll(() => readActiveComposition(orcaPage)).toBe('하')
      await testInfo.attach('native-macos-codex-korean-preedit.png', {
        body: await orcaPage.screenshot(),
        contentType: 'image/png'
      })
      typeNativeKorean([...KOREAN_TUI_REMAINING_KEY_CODES, 49])

      await orcaPage.waitForTimeout(1_000)
      const nativeTrace = await readTerminalImeBoundaryTrace(orcaPage)
      const nativeContent = await getTerminalContent(orcaPage, TERMINAL_DUMP_CHARS)
      console.log(
        `[codex-korean-ime] onData=${JSON.stringify(nativeTrace.onData.join(''))} ` +
          `screen=${JSON.stringify(nativeContent.slice(-500))}`
      )
      await testInfo.attach('native-macos-codex-korean.png', {
        body: await orcaPage.screenshot(),
        contentType: 'image/png'
      })

      const committedKorean = stripKeyReleaseReports(nativeTrace.onData.join(''))

      await orcaPage.keyboard.type('abc')
      await expect
        .poll(async () =>
          stripKeyReleaseReports((await readTerminalImeBoundaryTrace(orcaPage)).onData.join(''))
        )
        .toBe(`${committedKorean}abc`)
      await expect
        .poll(async () =>
          stripCsi(await getTerminalContent(orcaPage, TERMINAL_DUMP_CHARS))
            .replaceAll('\r', '')
            .replaceAll('\n', '')
        )
        .toContain(`${committedKorean.trim()}abc`)

      await attachTerminalImeBoundaryEvidence(orcaPage, testInfo, 'native-macos-codex-korean')

      expect(committedKorean).toBe(`${KOREAN_TUI_EXPECTED} `)
      expect(nativeContent).toContain(KOREAN_TUI_TEXT)
    } finally {
      await disposeTerminalImeBoundaryProbe(orcaPage).catch(() => undefined)
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
})
