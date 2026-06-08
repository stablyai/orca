import type { Page, TestInfo } from '@stablyai/playwright-test'
import {
  dispatchActiveTerminalWheelEvent,
  readActiveTerminalScrollState,
  scrollActiveTerminalByApi,
  scrollActiveTerminalToBottom,
  scrollActiveTerminalViewportElement,
  type ActiveTerminalScrollState
} from './artificial-opencode-active-terminal-scroll'
import {
  formatScrollAttempts,
  getResponsiveScrollPath,
  type ScrollAttemptMeasurement
} from './artificial-opencode-scroll-measurement'
import { sendToTerminal, waitForTerminalOutput } from './helpers/terminal'

export { getResponsiveScrollPath }

export type ScrollMeasurement = {
  scrollLatencyMs: number
  maxTimerDriftMs: number
  beforeViewportY: number
  afterViewportY: number
  baseY: number
  attempts: ScrollAttemptMeasurement[]
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
const SLOW_SCROLL_DIAGNOSTIC_MS = 150

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

export { scrollActiveTerminalToBottom }

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
    // Why: Linux headless can miss wheel input over xterm's text layer while
    // output is flooding; the viewport is the scrollable surface users affect.
    const wheelTarget =
      pane.container.querySelector<HTMLElement>('.xterm-viewport') ??
      pane.container.querySelector<HTMLElement>('.xterm') ??
      pane.container.querySelector<HTMLElement>('.xterm-screen')
    if (!wheelTarget) {
      throw new Error('Active terminal wheel target is unavailable')
    }
    const buffer = pane.terminal.buffer.active
    const rect = wheelTarget.getBoundingClientRect()
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

  let watcherStopped = false
  try {
    const start = performance.now()
    const attempts: ScrollAttemptMeasurement[] = []
    let afterViewportY = await measureScrollAttempt(page, attempts, 'cdpWheel', async () => {
      await page.mouse.move(target.x, target.y)
      await page.mouse.wheel(0, -1200)
    })
    let scrollLatencyMs = performance.now() - start
    const cdpWheelMoved = afterViewportY < target.beforeViewportY
    if (cdpWheelMoved && scrollLatencyMs >= SLOW_SCROLL_DIAGNOSTIC_MS) {
      await measureAdditionalScrollAttempts(page, attempts)
    }
    if (afterViewportY >= target.beforeViewportY) {
      afterViewportY = await measureScrollAttempt(page, attempts, 'domWheel', async () => {
        await dispatchActiveTerminalWheelEvent(page)
      })
      if (afterViewportY < target.beforeViewportY) {
        scrollLatencyMs = performance.now() - start
      }
    }
    if (afterViewportY >= target.beforeViewportY) {
      afterViewportY = await measureScrollAttempt(page, attempts, 'domScroll', async () => {
        await scrollActiveTerminalViewportElement(page)
      })
      if (afterViewportY < target.beforeViewportY) {
        scrollLatencyMs = performance.now() - start
      }
    }
    if (afterViewportY >= target.beforeViewportY) {
      afterViewportY = await measureScrollAttempt(page, attempts, 'xtermApi', async () => {
        await scrollActiveTerminalByApi(page)
      })
      if (afterViewportY < target.beforeViewportY) {
        scrollLatencyMs = performance.now() - start
      }
    }
    if (afterViewportY >= target.beforeViewportY) {
      const remainingMs = Math.max(0, 500 - (performance.now() - start))
      const finalState = await waitForActiveTerminalViewportChange(
        page,
        target.beforeViewportY,
        remainingMs
      )
      afterViewportY = finalState.viewportY
      const lastAttempt = attempts.at(-1)
      if (lastAttempt) {
        lastAttempt.afterViewportY = finalState.viewportY
        lastAttempt.afterScrollTop = finalState.scrollTop
      }
      if (afterViewportY < target.beforeViewportY) {
        scrollLatencyMs = performance.now() - start
      }
    }
    const maxTimerDriftMs = await eventLoop.evaluate((watcher) => watcher.stop())
    watcherStopped = true
    return {
      scrollLatencyMs,
      maxTimerDriftMs,
      beforeViewportY: target.beforeViewportY,
      afterViewportY,
      baseY: target.baseY,
      attempts
    }
  } finally {
    if (!watcherStopped) {
      await eventLoop.evaluate((watcher) => watcher.stop()).catch(() => undefined)
    }
    await eventLoop.dispose().catch(() => undefined)
  }
}

async function measureAdditionalScrollAttempts(
  page: Page,
  attempts: ScrollAttemptMeasurement[]
): Promise<void> {
  await scrollActiveTerminalToBottom(page)
  await measureScrollAttempt(page, attempts, 'domWheelAfterSlowCdp', async () => {
    await dispatchActiveTerminalWheelEvent(page)
  })
  await scrollActiveTerminalToBottom(page)
  await measureScrollAttempt(page, attempts, 'domScrollAfterSlowCdp', async () => {
    await scrollActiveTerminalViewportElement(page)
  })
  await scrollActiveTerminalToBottom(page)
  await measureScrollAttempt(page, attempts, 'xtermApiAfterSlowCdp', async () => {
    await scrollActiveTerminalByApi(page)
  })
}

export function annotateScrollMeasurement(
  testInfo: TestInfo,
  type: string,
  paneCount: number,
  measurement: ScrollMeasurement,
  mainPressure: ScrollMainPressureSnapshot | null,
  ackGate: ScrollAckGateSnapshot | null
): void {
  const scrollMoved = measurement.afterViewportY < measurement.beforeViewportY
  const responsiveScroll = getResponsiveScrollPath(measurement)
  const scrollMetric = responsiveScroll
    ? ` scroll=${responsiveScroll.latencyMs.toFixed(1)}ms scrollPath=${responsiveScroll.name}${
        responsiveScroll.name === 'cdpWheel'
          ? ''
          : ` cdpScroll=${measurement.scrollLatencyMs.toFixed(1)}ms`
      }`
    : ''
  const attempts = formatScrollAttempts(measurement.attempts)
  testInfo.annotations.push({
    type,
    description: `panes=${paneCount}${scrollMetric} scrollMoved=${scrollMoved} maxTimerDrift=${measurement.maxTimerDriftMs.toFixed(
      1
    )}ms viewportBefore=${measurement.beforeViewportY} viewportAfter=${
      measurement.afterViewportY
    } baseY=${measurement.baseY} scrollAttempts=${attempts} mainPeakPendingChars=${
      mainPressure?.peakPendingChars ?? 0
    } mainPeakInFlightChars=${mainPressure?.peakRendererInFlightChars ?? 0} mainAckGatedFlushSkips=${
      mainPressure?.ackGatedFlushSkipCount ?? 0
    } heldAckPtys=${ackGate?.heldAckCount ?? 0} heldAckChars=${
      ackGate?.heldAckChars ?? 0
    } gatedAckPtys=${ackGate?.gatedPtyCount ?? 0}`
  })
}

async function measureScrollAttempt(
  page: Page,
  attempts: ScrollAttemptMeasurement[],
  name: string,
  action: () => Promise<void>
): Promise<number> {
  const before = await readActiveTerminalScrollState(page)
  let error: string | undefined
  const actionStart = performance.now()
  try {
    await action()
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const actionMs = performance.now() - actionStart
  const afterAction = await readActiveTerminalScrollState(page)
  const observeStart = performance.now()
  const after = await waitForActiveTerminalViewportChange(page, before.viewportY, 75)
  const observeMs = performance.now() - observeStart
  attempts.push({
    name,
    actionMs,
    observeMs,
    beforeViewportY: before.viewportY,
    afterActionViewportY: afterAction.viewportY,
    afterViewportY: after.viewportY,
    beforeScrollTop: before.scrollTop,
    afterActionScrollTop: afterAction.scrollTop,
    afterScrollTop: after.scrollTop,
    error
  })
  return after.viewportY
}

async function waitForActiveTerminalViewportChange(
  page: Page,
  beforeViewportY: number,
  timeoutMs: number
): Promise<ActiveTerminalScrollState> {
  const start = performance.now()
  let state = await readActiveTerminalScrollState(page)
  while (performance.now() - start < timeoutMs) {
    state = await readActiveTerminalScrollState(page)
    if (state.viewportY < beforeViewportY) {
      break
    }
    await page.waitForTimeout(5)
  }
  return state
}
