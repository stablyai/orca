import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
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

// Reports must stop reaching the PTY shortly after the gesture ends. Before
// the input-write-queue coalescing fix, each SGR report drained in its own
// >=4ms-clamped macrotask turn; a dense trackpad stream delivered through the
// real input pipeline (which outprioritizes timers) plus TUI-scale redraw
// output starved that drain, and the backlog replayed for seconds after the
// fingers left the trackpad.
const MAX_ARRIVAL_LAG_MS = 900
// Why: each event is a serial CDP mouse.wheel round-trip that competes with the
// heavy TUI's per-report full-screen redraw, so under loaded CI a round-trip can
// take ~2.7s — 120 of them overran even the tripled test.slow() budget (360s).
// 60 back-to-back events (no inter-event sleep) is still a dense burst that
// exercises the drain/coalesce path while keeping the dispatch loop well inside
// the timeout.
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
        pane.terminal._core?._renderService?.dimensions?.css?.cell?.height ??
        rect.height / pane.terminal.rows
    }
  })
}

/**
 * Drives real wheel input (CDP mouse events through the compositor input
 * pipeline — the same priority class as physical trackpad input) rather than
 * synthetic DOM dispatchEvent, so input can genuinely compete with the
 * renderer's timer-based PTY input drain the way a physical gesture does.
 */
async function dispatchTrackpadWheelStream(
  page: Page,
  options: { alternate: boolean; events: number; deltaY: number }
): Promise<WheelStreamResult> {
  const target = await terminalWheelTarget(page)
  await page.mouse.move(target.x, target.y)
  for (let i = 0; i < options.events; i += 1) {
    const direction = options.alternate && Math.floor(i / 18) % 2 === 1 ? -1 : 1
    // No artificial sleep: CDP round-trips pace this near real trackpad rates
    // while keeping the renderer's input queue continuously occupied.
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
    fs.rmSync(logPath, { force: true })
    console.log(`[tui-wheel-drain] dense: ${JSON.stringify(summary)}`)

    // The full gesture distance must reach the TUI (no dead/eaten scrolls)...
    expect(summary.totalReports, JSON.stringify(summary)).toBeGreaterThanOrEqual(WHEEL_EVENTS - 10)
    // ...while the gesture happens, not replayed 1-by-1 afterwards.
    expect(summary.arrivalLagMs, JSON.stringify(summary)).toBeLessThanOrEqual(MAX_ARRIVAL_LAG_MS)
  })

  test('aggressive alternating trackpad-like gesture does not replay after input ends', async ({
    orcaPage
  }) => {
    // Why: the dense CDP wheel stream is throughput-bound on loaded CI runners.
    test.slow()
    const logPath = path.join(os.tmpdir(), `tui-wheel-drain-alt-${Date.now()}.log`)
    await startHeavyTuiFixture(orcaPage, logPath)

    const target = await terminalWheelTarget(orcaPage)
    const input = await dispatchTrackpadWheelStream(orcaPage, {
      alternate: true,
      events: WHEEL_EVENTS,
      deltaY: Math.min(49, target.cellHeight)
    })
    await orcaPage.waitForTimeout(8000)

    const summary = summarizeArrivals(readReportArrivalLog(logPath), input)
    fs.rmSync(logPath, { force: true })
    console.log(`[tui-wheel-drain] alternate: ${JSON.stringify(summary)}`)

    expect(summary.arrivalLagMs, JSON.stringify(summary)).toBeLessThanOrEqual(MAX_ARRIVAL_LAG_MS)
  })
})
