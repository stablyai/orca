import { existsSync, readFileSync } from 'fs'
import path from 'path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { waitForTerminalPtyDataInjector } from './helpers/terminal-pty-injection'

// Repro commands:
//   SKIP_BUILD=1 pnpm exec playwright test tests/e2e/terminal-foreground-redraw-freeze.spec.ts --config tests/playwright.config.ts --project electron-headless -g "active OpenTUI-style"
//   git clone https://github.com/anomalyco/opencode.git .tmp/opencode
//   node tests/e2e/capture-opencode-tui-repro.mjs
//   SKIP_BUILD=1 pnpm exec playwright test tests/e2e/terminal-foreground-redraw-freeze.spec.ts --config tests/playwright.config.ts --project electron-headless -g "captured OpenCode/OpenTUI" --reporter=json
// The captured replay uses an artificial OpenCode source-tree harness that
// imports OpenCode's spinner frames and emits real OpenTUI <=2KB redraw chunks.

type SchedulerDebugSnapshot = {
  deferredForegroundEnqueueCount: number
  foregroundWriteCount: number
  deferredForegroundWriteCount: number
  scheduledDrainCount: number
  drainWrites: number[]
}

type BurstMeasurement = {
  elapsedMs: number
  injectedFrames: number
  maxTimerDriftMs: number
  samples: number
}

type SchedulerDebugWindow = Window & {
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => SchedulerDebugSnapshot
  }
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string) => boolean
  }
}

const REDRAW_FRAME_COUNT = 270
const REDRAW_PAYLOAD_CHARS = 520
const TIMER_SAMPLE_MS = 16
const MAX_RENDERER_TIMER_DRIFT_MS = 500
const FOREGROUND_IMMEDIATE_BUDGET_CHARS = 128 * 1024
const OPENCODE_CAPTURE_REPLAY_CHARS = FOREGROUND_IMMEDIATE_BUDGET_CHARS * 64
const OPENCODE_CAPTURE_PATH = path.join(process.cwd(), '.tmp', 'opencode-tui-capture.txt')

async function resetSchedulerDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    const debug = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('terminal output scheduler debug API is unavailable')
    }
    debug.reset()
  })
}

async function readSchedulerDebug(page: Page): Promise<SchedulerDebugSnapshot> {
  return page.evaluate(() => {
    const debug = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('terminal output scheduler debug API is unavailable')
    }
    return debug.snapshot()
  })
}

async function measureRendererDuringBurst(page: Page, paneKey: string): Promise<BurstMeasurement> {
  const frames = Array.from({ length: REDRAW_FRAME_COUNT }, (_, frame) => {
    const text = `OpenTUI active redraw #${String(frame).padStart(4, '0')}`
    const payload = 'x'.repeat(REDRAW_PAYLOAD_CHARS)
    return (
      '\x1b[?2026h' +
      '\x1b[?25l' +
      `\x1b[2;3H\x1b[38;2;255;138;0m${text}\x1b[0m` +
      `\x1b[4;6H\x1b[38;2;231;237;247m${payload}\x1b[0m` +
      '\x1b[?2026l'
    )
  })
  return measureRendererDuringFrames(page, paneKey, frames)
}

async function measureRendererDuringFrames(
  page: Page,
  paneKey: string,
  frames: string[]
): Promise<BurstMeasurement> {
  return page.evaluate(
    async ({ paneKey, sampleMs, frames }) => {
      const injector = (window as SchedulerDebugWindow).__terminalPtyDataInjection
      if (!injector) {
        throw new Error('terminal PTY data injection API is unavailable')
      }

      let maxTimerDriftMs = 0
      let samples = 0
      let lastTick = performance.now()
      const startedAt = lastTick
      const timer = window.setInterval(() => {
        const now = performance.now()
        maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - sampleMs)
        lastTick = now
        samples += 1
      }, sampleMs)

      let injectedFrames = 0
      for (const data of frames) {
        if (data.length > 2048) {
          throw new Error(`repro frame unexpectedly exceeded 2048 chars: ${data.length}`)
        }
        if (!injector.inject(paneKey, data)) {
          throw new Error(`no PTY data injector registered for pane key ${paneKey}`)
        }
        injectedFrames += 1
      }
      await new Promise((resolve) => window.setTimeout(resolve, sampleMs * 2))
      window.clearInterval(timer)

      return {
        elapsedMs: performance.now() - startedAt,
        injectedFrames,
        maxTimerDriftMs,
        samples
      }
    },
    {
      paneKey,
      sampleMs: TIMER_SAMPLE_MS,
      frames
    }
  )
}

function loadCapturedOpenCodeSmallRedrawFrames(): string[] {
  if (!existsSync(OPENCODE_CAPTURE_PATH)) {
    return []
  }
  const capture = readFileSync(OPENCODE_CAPTURE_PATH, 'utf8')
  const smallFrames = capture
    .split('\x1b[?2026h')
    .slice(1)
    .map((segment) => `\x1b[?2026h${segment}`)
    .filter((segment) => segment.length <= 2048 && segment.includes('\x1b['))

  const frames: string[] = []
  let totalChars = 0
  while (smallFrames.length > 0 && totalChars <= OPENCODE_CAPTURE_REPLAY_CHARS) {
    for (const frame of smallFrames) {
      frames.push(frame)
      totalChars += frame.length
      if (totalChars > OPENCODE_CAPTURE_REPLAY_CHARS) {
        break
      }
    }
  }
  return frames
}

function annotateMeasurement(
  testInfo: TestInfo,
  measurement: BurstMeasurement,
  scheduler: SchedulerDebugSnapshot
): void {
  testInfo.annotations.push({
    type: 'foreground-redraw-repro',
    description: `elapsed=${measurement.elapsedMs.toFixed(1)}ms maxTimerDrift=${measurement.maxTimerDriftMs.toFixed(
      1
    )}ms samples=${measurement.samples} foregroundWrites=${scheduler.foregroundWriteCount} deferredForegroundEnqueues=${
      scheduler.deferredForegroundEnqueueCount
    } deferredForegroundWrites=${scheduler.deferredForegroundWriteCount} scheduledDrains=${
      scheduler.scheduledDrainCount
    }`
  })
}

test.describe('Terminal foreground redraw freeze repro', () => {
  test('active OpenTUI-style redraw bursts do not monopolize the renderer', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    await waitForTerminalPtyDataInjector(orcaPage, paneKey)
    await resetSchedulerDebug(orcaPage)
    const measurement = await measureRendererDuringBurst(orcaPage, paneKey)
    const scheduler = await readSchedulerDebug(orcaPage)
    annotateMeasurement(testInfo, measurement, scheduler)

    expect(measurement.injectedFrames).toBe(REDRAW_FRAME_COUNT)
    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_RENDERER_TIMER_DRIFT_MS)
    // Why: this is the PR #4558 contract. Once the foreground immediate budget
    // is exhausted, throughput redraws must enter the async foreground drain.
    expect(scheduler.deferredForegroundEnqueueCount).toBeGreaterThan(0)
  })

  test('captured OpenCode/OpenTUI redraw bytes do not monopolize foreground writes', async ({
    orcaPage
  }, testInfo) => {
    const frames = loadCapturedOpenCodeSmallRedrawFrames()
    test.skip(
      frames.length === 0,
      `OpenCode PTY capture missing; run "git clone https://github.com/anomalyco/opencode.git .tmp/opencode" then "node tests/e2e/capture-opencode-tui-repro.mjs" to generate ${OPENCODE_CAPTURE_PATH}`
    )

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    await waitForTerminalPtyDataInjector(orcaPage, paneKey)
    await resetSchedulerDebug(orcaPage)
    const measurement = await measureRendererDuringFrames(orcaPage, paneKey, frames)
    const scheduler = await readSchedulerDebug(orcaPage)
    annotateMeasurement(testInfo, measurement, scheduler)

    expect(measurement.injectedFrames).toBe(frames.length)
    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_RENDERER_TIMER_DRIFT_MS)
    expect(scheduler.deferredForegroundEnqueueCount).toBeGreaterThan(0)
  })
})
