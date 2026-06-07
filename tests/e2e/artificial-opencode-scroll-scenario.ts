import type { Page, TestInfo } from '@stablyai/playwright-test'
import { sendToTerminal, waitForTerminalOutput } from './helpers/terminal'

export type ScrollMeasurement = {
  scrollLatencyMs: number
  maxTimerDriftMs: number
  beforeViewportY: number
  afterViewportY: number
  baseY: number
}

type ScrollMainPressureSnapshot = {
  peakPendingChars: number
  peakRendererInFlightChars: number
  ackGatedFlushSkipCount: number
}

type ScrollAckGateSnapshot = {
  heldAckChars: number
  heldAckCount: number
  gatedPtyCount: number
}

const TIMER_SAMPLE_MS = 16

export async function seedActiveTerminalScrollback(
  page: Page,
  ptyId: string,
  runId: string
): Promise<void> {
  const marker = `OPENCODE_SCROLL_READY_${runId}`
  const script = [
    `for (let i = 0; i < 420; i++) console.log('OPENCODE_SCROLL_${runId}_' + i)`,
    `console.log('${marker}')`
  ].join(';')
  await sendToTerminal(page, ptyId, `node -e ${JSON.stringify(script)}\r`)
  await waitForTerminalOutput(page, marker, 10_000)
  await scrollActiveTerminalToBottom(page)
}

export async function scrollActiveTerminalToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pane = (() => {
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
      const candidate = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!candidate) {
        throw new Error('Active terminal pane is unavailable')
      }
      return candidate
    })()
    pane.terminal.scrollToBottom()
  })
}

export async function measureActiveTerminalWheelScroll(page: Page): Promise<ScrollMeasurement> {
  const target = await page.evaluate(() => {
    const pane = (() => {
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
      const candidate = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!candidate) {
        throw new Error('Active terminal pane is unavailable')
      }
      return candidate
    })()
    pane.terminal.focus()
    pane.terminal.scrollToBottom()
    const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) {
      throw new Error('Active terminal screen is unavailable')
    }
    const buffer = pane.terminal.buffer.active
    const rect = screen.getBoundingClientRect()
    return {
      baseY: buffer.baseY,
      beforeViewportY: buffer.viewportY,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    }
  })
  if (target.baseY <= 0) {
    throw new Error('Active terminal has no scrollback to measure')
  }

  const eventLoop = await page.evaluateHandle((sampleMs) => {
    let maxTimerDriftMs = 0
    let lastTick = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - sampleMs)
      lastTick = now
    }, sampleMs)
    return {
      stop: () => {
        window.clearInterval(timer)
        return maxTimerDriftMs
      }
    }
  }, TIMER_SAMPLE_MS)

  const start = performance.now()
  await page.mouse.move(target.x, target.y)
  await page.mouse.wheel(0, -1200)
  let afterViewportY = target.beforeViewportY
  while (performance.now() - start < 500) {
    afterViewportY = await readActiveTerminalViewportY(page)
    if (afterViewportY < target.beforeViewportY) {
      break
    }
    await page.waitForTimeout(5)
  }
  const scrollLatencyMs = performance.now() - start
  const maxTimerDriftMs = await eventLoop.evaluate((watcher) => watcher.stop())
  await eventLoop.dispose()
  return {
    scrollLatencyMs,
    maxTimerDriftMs,
    beforeViewportY: target.beforeViewportY,
    afterViewportY,
    baseY: target.baseY
  }
}

export function annotateScrollMeasurement(
  testInfo: TestInfo,
  type: string,
  paneCount: number,
  measurement: ScrollMeasurement,
  mainPressure: ScrollMainPressureSnapshot | null,
  ackGate: ScrollAckGateSnapshot | null
): void {
  testInfo.annotations.push({
    type,
    description: `panes=${paneCount} scroll=${measurement.scrollLatencyMs.toFixed(
      1
    )}ms maxTimerDrift=${measurement.maxTimerDriftMs.toFixed(
      1
    )}ms viewportBefore=${measurement.beforeViewportY} viewportAfter=${
      measurement.afterViewportY
    } baseY=${measurement.baseY} mainPeakPendingChars=${
      mainPressure?.peakPendingChars ?? 0
    } mainPeakInFlightChars=${mainPressure?.peakRendererInFlightChars ?? 0} mainAckGatedFlushSkips=${
      mainPressure?.ackGatedFlushSkipCount ?? 0
    } heldAckPtys=${ackGate?.heldAckCount ?? 0} heldAckChars=${
      ackGate?.heldAckChars ?? 0
    } gatedAckPtys=${ackGate?.gatedPtyCount ?? 0}`
  })
}

async function readActiveTerminalViewportY(page: Page): Promise<number> {
  return page.evaluate(() => {
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
      throw new Error('Active terminal pane is unavailable')
    }
    return pane.terminal.buffer.active.viewportY
  })
}
