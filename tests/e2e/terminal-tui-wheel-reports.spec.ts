import type { Page } from '@stablyai/playwright-test'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

type WheelReportSample = {
  reportCount: number
  reportDelta: number
  reports: string[]
}

type TimedWheelReportSample = WheelReportSample & {
  elapsedMs: number
}

const PHYSICAL_MOUSE_WHEEL_DELTA = -120
const VISIBLE_TUI_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/visible-tui-scroll-fixture.cjs'
)

async function probeSmallMouseWheelReports(
  page: Page,
  ticks: number
): Promise<WheelReportSample[]> {
  return page.evaluate(
    async ({ tickCount, physicalMouseWheelDelta }) => {
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
      if (!pane?.terminal.element) {
        throw new Error('Active terminal pane unavailable')
      }

      const reports: string[] = []
      const disposable = pane.terminal.onData((data) => reports.push(data))
      try {
        await new Promise<void>((resolve) => pane.terminal.write('\x1b[?1003h\x1b[?1006h', resolve))
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        if (!pane.terminal.element.classList.contains('enable-mouse-events')) {
          throw new Error('Mouse reporting mode did not activate')
        }

        const screen = pane.terminal.element.querySelector<HTMLElement>('.xterm-screen')
        if (!screen) {
          throw new Error('Active terminal screen unavailable')
        }

        const rect = screen.getBoundingClientRect()
        const cellHeight =
          pane.terminal._core?._renderService?.dimensions?.css?.cell?.height ??
          rect.height / pane.terminal.rows
        const scrollSensitivity = Number(pane.terminal.options.scrollSensitivity ?? 1)
        // Why: this is a notched mouse wheel event that Chromium can surface as a
        // small pixel delta; xterm's <50px damping accumulates it for four ticks.
        const deltaY = (cellHeight * 0.28) / (scrollSensitivity * 0.3)
        const samples: WheelReportSample[] = []

        for (let i = 0; i < tickCount; i += 1) {
          const before = reports.length
          const event = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + Math.min(rect.height - 1, cellHeight * 4),
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            deltaY
          })
          Object.defineProperty(event, 'wheelDeltaY', {
            configurable: true,
            value: physicalMouseWheelDelta
          })
          Object.defineProperty(event, 'wheelDelta', {
            configurable: true,
            value: physicalMouseWheelDelta
          })
          pane.terminal.element.dispatchEvent(event)
          // Why: space notches past TUI_WHEEL_BURST_MAX_INTERVAL_MS (45ms) so
          // burst-acceleration (which intentionally coalesces fast trackpad
          // flicks into multi-row reports) does not engage — a notched mouse
          // wheel maps 1:1. At setTimeout(0) the ticks land <45ms apart and
          // the burst path fires, yielding [1,1,3,3] instead of [1,1,1,1].
          await new Promise((resolve) => setTimeout(resolve, 60))
          samples.push({
            reportCount: reports.length,
            reportDelta: reports.length - before,
            reports: [...reports]
          })
        }

        return samples
      } finally {
        disposable.dispose()
      }
    },
    { tickCount: ticks, physicalMouseWheelDelta: PHYSICAL_MOUSE_WHEEL_DELTA }
  )
}

async function probeTimedSmallMouseWheelReports(
  page: Page,
  options: {
    drainWaitMs: number
    intervalMs: number
    ticks: number
  }
): Promise<{
  reports: string[]
  samples: TimedWheelReportSample[]
}> {
  return page.evaluate(
    async ({ drainWaitMs, intervalMs, physicalMouseWheelDelta, tickCount }) => {
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
      if (!pane?.terminal.element) {
        throw new Error('Active terminal pane unavailable')
      }

      const reports: string[] = []
      const disposable = pane.terminal.onData((data) => reports.push(data))
      try {
        await new Promise<void>((resolve) => pane.terminal.write('\x1b[?1003h\x1b[?1006h', resolve))
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        if (!pane.terminal.element.classList.contains('enable-mouse-events')) {
          throw new Error('Mouse reporting mode did not activate')
        }

        const screen = pane.terminal.element.querySelector<HTMLElement>('.xterm-screen')
        if (!screen) {
          throw new Error('Active terminal screen unavailable')
        }

        const rect = screen.getBoundingClientRect()
        const cellHeight =
          pane.terminal._core?._renderService?.dimensions?.css?.cell?.height ??
          rect.height / pane.terminal.rows
        const scrollSensitivity = Number(pane.terminal.options.scrollSensitivity ?? 1)
        // Why: this is a notched mouse wheel event that Chromium can surface as a
        // small pixel delta; xterm's <50px damping accumulates it for four ticks.
        const deltaY = (cellHeight * 0.28) / (scrollSensitivity * 0.3)
        const samples: TimedWheelReportSample[] = []
        const startedAt = performance.now()

        for (let i = 0; i < tickCount; i += 1) {
          const before = reports.length
          const event = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + Math.min(rect.height - 1, cellHeight * 4),
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            deltaY
          })
          Object.defineProperty(event, 'wheelDeltaY', {
            configurable: true,
            value: physicalMouseWheelDelta
          })
          Object.defineProperty(event, 'wheelDelta', {
            configurable: true,
            value: physicalMouseWheelDelta
          })
          pane.terminal.element.dispatchEvent(event)
          await new Promise((resolve) => setTimeout(resolve, intervalMs))
          samples.push({
            elapsedMs: performance.now() - startedAt,
            reportCount: reports.length,
            reportDelta: reports.length - before,
            reports: [...reports]
          })
        }

        await new Promise((resolve) => setTimeout(resolve, drainWaitMs))

        return {
          reports: [...reports],
          samples
        }
      } finally {
        disposable.dispose()
      }
    },
    {
      drainWaitMs: options.drainWaitMs,
      intervalMs: options.intervalMs,
      physicalMouseWheelDelta: PHYSICAL_MOUSE_WHEEL_DELTA,
      tickCount: options.ticks
    }
  )
}

async function readVisibleTuiOffset(page: Page): Promise<number | null> {
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
    if (!pane?.terminal) {
      return null
    }

    for (let row = 0; row < pane.terminal.rows; row += 1) {
      const text = pane.terminal.buffer.active.getLine(row)?.translateToString(true) ?? ''
      const match = /TUI_SCROLL_ROW_(\d+)/.exec(text)
      if (match) {
        return Number(match[1])
      }
    }
    return null
  })
}

async function dispatchTuiWheel(
  page: Page,
  options: {
    deltaY: number
    wheelDeltaY?: number
  }
): Promise<void> {
  await page.evaluate(({ deltaY, wheelDeltaY }) => {
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
    if (!pane?.terminal.element) {
      throw new Error('Active terminal pane unavailable')
    }

    const screen = pane.terminal.element.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) {
      throw new Error('Active terminal screen unavailable')
    }
    const rect = screen.getBoundingClientRect()
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + Math.min(rect.height - 1, 40),
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY
    })
    if (wheelDeltaY !== undefined) {
      Object.defineProperty(event, 'wheelDeltaY', {
        configurable: true,
        value: wheelDeltaY
      })
      Object.defineProperty(event, 'wheelDelta', {
        configurable: true,
        value: wheelDeltaY
      })
    }
    pane.terminal.element.dispatchEvent(event)
  }, options)
}

test.describe('terminal TUI wheel reports', () => {
  test('notched mouse wheel ticks produce immediate mouse-reporting TUI scroll reports', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.evaluate(() =>
      window.__store?.getState().updateSettings({ terminalTuiScrollSensitivity: 1 })
    )

    const samples = await probeSmallMouseWheelReports(orcaPage, 4)

    expect(
      samples.map((sample) => sample.reportDelta),
      `per-tick SGR mouse reports: ${JSON.stringify(samples)}`
    ).toEqual([1, 1, 1, 1])
    expect(samples.at(-1)?.reports.join('')).toContain('\x1b[<65;')
  })

  test('fullscreen mouse-reporting TUI scroll distance follows wheel magnitude @headful', async ({
    electronApp,
    orcaPage
  }) => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) {
        throw new Error('No BrowserWindow available')
      }
      if (win.isMinimized()) {
        win.restore()
      }
      win.show()
      win.focus()
      win.setFullScreen(true)
    })
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false
        )
      )
      .toBe(true)
    await orcaPage.waitForTimeout(1200)

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.evaluate(() =>
      window.__store?.getState().updateSettings({ terminalTuiScrollSensitivity: 1 })
    )

    const ptyId = await waitForActivePanePtyId(orcaPage)
    await execInTerminal(orcaPage, ptyId, `node ${JSON.stringify(VISIBLE_TUI_FIXTURE_PATH)}`)

    await expect
      .poll(() => readVisibleTuiOffset(orcaPage), {
        timeout: 10_000,
        message: 'visible fullscreen TUI did not render numbered rows'
      })
      .toBe(0)

    await dispatchTuiWheel(orcaPage, {
      deltaY: 10,
      wheelDeltaY: PHYSICAL_MOUSE_WHEEL_DELTA
    })
    await expect
      .poll(() => readVisibleTuiOffset(orcaPage), {
        timeout: 5_000,
        message: 'single notched wheel tick did not visibly scroll the TUI'
      })
      .toBe(1)

    const cellHeight = await orcaPage.evaluate(() => {
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
      return screen.getBoundingClientRect().height / pane.terminal.rows
    })

    await dispatchTuiWheel(orcaPage, {
      deltaY: cellHeight * 12,
      wheelDeltaY: PHYSICAL_MOUSE_WHEEL_DELTA * 12
    })

    await expect
      .poll(() => readVisibleTuiOffset(orcaPage), {
        timeout: 5_000,
        message: 'larger wheel movement did not visibly move the TUI farther'
      })
      .toBe(7)
  })

  test('TUI scroll setting scales notched mouse wheel reports', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.evaluate(() =>
      window.__store?.getState().updateSettings({ terminalTuiScrollSensitivity: 5 })
    )

    const slow = await probeTimedSmallMouseWheelReports(orcaPage, {
      drainWaitMs: 120,
      intervalMs: 220,
      ticks: 5
    })
    await orcaPage.waitForTimeout(220)
    const paced = await probeTimedSmallMouseWheelReports(orcaPage, {
      drainWaitMs: 220,
      intervalMs: 80,
      ticks: 5
    })

    expect(
      slow.samples.map((sample) => sample.reportDelta),
      `slow per-tick SGR mouse reports: ${JSON.stringify(slow.samples)}`
    ).toEqual([5, 5, 5, 5, 5])
    expect(
      paced.samples.map((sample) => sample.reportDelta),
      `paced per-tick SGR mouse reports: ${JSON.stringify(paced.samples)}`
    ).toEqual([5, 5, 5, 5, 5])
    expect(paced.reports.length, `paced SGR mouse reports: ${JSON.stringify(paced.samples)}`).toBe(
      25
    )
  })
})
