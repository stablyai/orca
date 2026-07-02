import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

type WheelReportSample = {
  reportCount: number
  reportDelta: number
  reports: string[]
}

const PHYSICAL_MOUSE_WHEEL_DELTA = -120

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
          await new Promise((resolve) => setTimeout(resolve, 0))
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
})
