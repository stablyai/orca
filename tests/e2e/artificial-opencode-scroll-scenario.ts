import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import {
  dispatchActiveTerminalWheelEvent,
  readActiveTerminalScrollState,
  scrollActiveTerminalByApi,
  scrollActiveTerminalToBottom,
  scrollActiveTerminalViewportElement,
  waitForActiveTerminalViewportChange
} from './artificial-opencode-active-terminal-scroll'
import {
  getResponsiveScrollPath,
  type ScrollAttemptMeasurement
} from './artificial-opencode-scroll-measurement'
import { annotateScrollMeasurement } from './artificial-opencode-scroll-annotation'
import { writePtyInputAccepted } from './helpers/terminal-accepted-input'
import { terminalOutputIncludesMarker } from './helpers/terminal-pty-content'

export { annotateScrollMeasurement, getResponsiveScrollPath }

export type ScrollMeasurement = {
  scrollLatencyMs: number
  maxTimerDriftMs: number
  beforeViewportY: number
  afterViewportY: number
  baseY: number
  attempts: ScrollAttemptMeasurement[]
}

const TIMER_SAMPLE_MS = 16
const SLOW_SCROLL_DIAGNOSTIC_MS = 150

export async function seedActiveTerminalScrollback(
  page: Page,
  ptyId: string,
  runId: string
): Promise<void> {
  const marker = `OPENCODE_SCROLL_READY_${runId}`
  const markerParts = JSON.stringify(['OPENCODE_SCROLL_READY', runId])
  const script = [
    `for (let i = 0; i < 420; i++) console.log('OPENCODE_SCROLL_${runId}_' + i)`,
    `console.log(${markerParts}.join('_'))`
  ].join(';')
  await writePtyInputAccepted(page, ptyId, `\x03\x15node -e ${JSON.stringify(script)}\r`)
  await expect
    .poll(async () => terminalOutputIncludesMarker(page, ptyId, marker, true), {
      timeout: 20_000,
      message: `Terminal PTY ${ptyId} did not contain "${marker}"`
    })
    .toBe(true)
  await scrollActiveTerminalToBottom(page, ptyId)
}

export { scrollActiveTerminalToBottom }

export async function measureActiveTerminalWheelScroll(
  page: Page,
  ptyId?: string
): Promise<ScrollMeasurement> {
  const target = await page.evaluate((targetPtyId) => {
    const pane = (() => {
      if (targetPtyId) {
        for (const manager of window.__paneManagers?.values() ?? []) {
          const candidate = manager
            .getPanes?.()
            .find((terminalPane) => terminalPane.container?.dataset?.ptyId === targetPtyId)
          if (candidate) {
            return candidate
          }
        }
        throw new Error(`Terminal PTY ${targetPtyId} is unavailable`)
      }
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
  }, ptyId ?? null)
  if (target.baseY <= 0) {
    throw new Error(
      ptyId
        ? `Terminal PTY ${ptyId} has no scrollback to measure`
        : 'Active terminal has no scrollback to measure'
    )
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
    let afterViewportY = await measureScrollAttempt(
      page,
      attempts,
      'cdpWheel',
      async () => {
        await page.mouse.move(target.x, target.y)
        await page.mouse.wheel(0, -1200)
      },
      ptyId
    )
    let scrollLatencyMs = performance.now() - start
    const cdpWheelMoved = afterViewportY < target.beforeViewportY
    if (cdpWheelMoved && scrollLatencyMs >= SLOW_SCROLL_DIAGNOSTIC_MS) {
      await measureAdditionalScrollAttempts(page, attempts, ptyId)
    }
    if (afterViewportY >= target.beforeViewportY) {
      afterViewportY = await measureScrollAttempt(
        page,
        attempts,
        'domWheel',
        async () => {
          await dispatchActiveTerminalWheelEvent(page, ptyId)
        },
        ptyId
      )
      if (afterViewportY < target.beforeViewportY) {
        scrollLatencyMs = performance.now() - start
      }
    }
    if (afterViewportY >= target.beforeViewportY) {
      afterViewportY = await measureScrollAttempt(
        page,
        attempts,
        'domScroll',
        async () => {
          await scrollActiveTerminalViewportElement(page, ptyId)
        },
        ptyId
      )
      if (afterViewportY < target.beforeViewportY) {
        scrollLatencyMs = performance.now() - start
      }
    }
    if (afterViewportY >= target.beforeViewportY) {
      afterViewportY = await measureScrollAttempt(
        page,
        attempts,
        'xtermApi',
        async () => {
          await scrollActiveTerminalByApi(page, ptyId)
        },
        ptyId
      )
      if (afterViewportY < target.beforeViewportY) {
        scrollLatencyMs = performance.now() - start
      }
    }
    if (afterViewportY >= target.beforeViewportY) {
      const remainingMs = Math.max(0, 500 - (performance.now() - start))
      const finalState = await waitForActiveTerminalViewportChange(
        page,
        target.beforeViewportY,
        remainingMs,
        ptyId
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
  attempts: ScrollAttemptMeasurement[],
  ptyId?: string
): Promise<void> {
  await scrollActiveTerminalToBottom(page, ptyId)
  await measureScrollAttempt(
    page,
    attempts,
    'domWheelAfterSlowCdp',
    async () => {
      await dispatchActiveTerminalWheelEvent(page, ptyId)
    },
    ptyId
  )
  await scrollActiveTerminalToBottom(page, ptyId)
  await measureScrollAttempt(
    page,
    attempts,
    'domScrollAfterSlowCdp',
    async () => {
      await scrollActiveTerminalViewportElement(page, ptyId)
    },
    ptyId
  )
  await scrollActiveTerminalToBottom(page, ptyId)
  await measureScrollAttempt(
    page,
    attempts,
    'xtermApiAfterSlowCdp',
    async () => {
      await scrollActiveTerminalByApi(page, ptyId)
    },
    ptyId
  )
}

async function measureScrollAttempt(
  page: Page,
  attempts: ScrollAttemptMeasurement[],
  name: string,
  action: () => Promise<void>,
  ptyId?: string
): Promise<number> {
  const before = await readActiveTerminalScrollState(page, ptyId)
  let error: string | undefined
  const actionStart = performance.now()
  try {
    await action()
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const actionMs = performance.now() - actionStart
  const afterAction = await readActiveTerminalScrollState(page, ptyId)
  const observeStart = performance.now()
  const after = await waitForActiveTerminalViewportChange(page, before.viewportY, 75, ptyId)
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
