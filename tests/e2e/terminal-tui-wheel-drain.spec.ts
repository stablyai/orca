import type { XtermWithRenderDimensions } from './helpers/xterm-render-dimensions'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { startHiddenRendererFrameCapture } from './helpers/hidden-renderer-frame-capture'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const VISIBLE_TUI_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/visible-tui-scroll-fixture.cjs'
)

// Require reports to stop promptly after gesture: old ≥4ms per-report macrotasks starved behind prioritized input/TUI redraw and replayed seconds later.
const MAX_ARRIVAL_LAG_MS = 900
// Use 60 uninterrupted events: serial CDP/redraw round-trips can take ~2.7s on loaded CI, making 120 overrun even 360s.
const WHEEL_EVENTS = 60

type WheelStreamResult = {
  dispatchedEvents: number
  inputEndWallClockMs: number
}

async function startHeavyTuiFixture(page: Page, logPath: string): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await page.evaluate(() =>
    window.__store?.getState().updateSettings({ terminalTuiScrollSensitivity: 1 })
  )

  const ptyId = await waitForActivePanePtyId(page)
  await execInTerminal(
    page,
    ptyId,
    `node ${JSON.stringify(VISIBLE_TUI_FIXTURE_PATH)} --heavy --log ${JSON.stringify(logPath)}`
  )

  await expect
    .poll(
      () =>
        page.evaluate(() => {
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
          return pane?.terminal.element?.classList.contains('enable-mouse-events') ?? false
        }),
      { timeout: 15_000, message: 'fixture did not enable mouse reporting' }
    )
    .toBe(true)
}

async function terminalWheelTarget(
  page: Page
): Promise<{ x: number; y: number; cellHeight: number }> {
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
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane?.terminal || !screen) {
      throw new Error('Active terminal screen unavailable')
    }
    const rect = screen.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + Math.min(rect.height - 1, 40),
      cellHeight:
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm has no public cell-size API; the private render service is read through all-optional fields.
        (pane.terminal as XtermWithRenderDimensions)._core?._renderService?.dimensions?.css?.cell
          ?.height ?? rect.height / pane.terminal.rows
    }
  })
}

// Use compositor CDP wheel events, not DOM dispatch, to compete with timer-based input drain at physical-input priority.
async function dispatchTrackpadWheelStream(
  page: Page,
  options: { alternate: boolean; events: number; deltaY: number }
): Promise<WheelStreamResult> {
  const target = await terminalWheelTarget(page)
  await page.mouse.move(target.x, target.y)
  for (let i = 0; i < options.events; i += 1) {
    const direction = options.alternate && Math.floor(i / 18) % 2 === 1 ? -1 : 1
    // No sleep: CDP round-trips pace input while continuously occupying its queue.
    await page.mouse.wheel(0, direction * options.deltaY)
  }
  const inputEndWallClockMs = await page.evaluate(() => Date.now())
  return { dispatchedEvents: options.events, inputEndWallClockMs }
}

type ReportArrival = { atMs: number; reports: number }

function readReportArrivalLog(logPath: string): ReportArrival[] {
  if (!fs.existsSync(logPath)) {
    return []
  }
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [atMs, reports] = line.split(' ')
      return { atMs: Number(atMs), reports: Number(reports) }
    })
}

function summarizeArrivals(
  arrivals: ReportArrival[],
  input: WheelStreamResult
): { arrivalLagMs: number; chunks: number; totalReports: number } {
  const totalReports = arrivals.reduce((sum, entry) => sum + entry.reports, 0)
  const lastArrivalMs = arrivals.at(-1)?.atMs ?? 0
  return {
    arrivalLagMs: lastArrivalMs - input.inputEndWallClockMs,
    chunks: arrivals.length,
    totalReports
  }
}

test.describe('terminal TUI wheel report drain', () => {
  test('dense trackpad-like wheel stream reaches the PTY while the gesture happens', async ({
    orcaPage
  }) => {
    // Why: the dense CDP wheel stream is throughput-bound on loaded CI runners.
    test.slow()
    const logPath = path.join(os.tmpdir(), `tui-wheel-drain-${Date.now()}.log`)
    const stopFrameCapture = await startHiddenRendererFrameCapture(orcaPage)
    try {
      await startHeavyTuiFixture(orcaPage, logPath)

      const target = await terminalWheelTarget(orcaPage)
      const input = await dispatchTrackpadWheelStream(orcaPage, {
        alternate: false,
        events: WHEEL_EVENTS,
        deltaY: Math.min(49, target.cellHeight)
      })
      // Give a laggy drain ample time to expose itself before reading the log.
      await orcaPage.waitForTimeout(8000)

      const summary = summarizeArrivals(readReportArrivalLog(logPath), input)
      console.log(`[tui-wheel-drain] dense: ${JSON.stringify(summary)}`)

      expect(summary.totalReports, JSON.stringify(summary)).toBeGreaterThanOrEqual(
        WHEEL_EVENTS - 10
      )
      expect(summary.arrivalLagMs, JSON.stringify(summary)).toBeLessThanOrEqual(MAX_ARRIVAL_LAG_MS)
    } finally {
      await stopFrameCapture()
      fs.rmSync(logPath, { force: true })
    }
  })

  test('aggressive alternating trackpad-like gesture does not replay after input ends', async ({
    orcaPage
  }) => {
    // Why: the dense CDP wheel stream is throughput-bound on loaded CI runners.
    test.slow()
    const logPath = path.join(os.tmpdir(), `tui-wheel-drain-alt-${Date.now()}.log`)
    const stopFrameCapture = await startHiddenRendererFrameCapture(orcaPage)
    try {
      await startHeavyTuiFixture(orcaPage, logPath)

      const target = await terminalWheelTarget(orcaPage)
      const input = await dispatchTrackpadWheelStream(orcaPage, {
        alternate: true,
        events: WHEEL_EVENTS,
        deltaY: Math.min(49, target.cellHeight)
      })
      await orcaPage.waitForTimeout(8000)

      const summary = summarizeArrivals(readReportArrivalLog(logPath), input)
      console.log(`[tui-wheel-drain] alternate: ${JSON.stringify(summary)}`)

      expect(summary.arrivalLagMs, JSON.stringify(summary)).toBeLessThanOrEqual(MAX_ARRIVAL_LAG_MS)
    } finally {
      await stopFrameCapture()
      fs.rmSync(logPath, { force: true })
    }
  })
})
