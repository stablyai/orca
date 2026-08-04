import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  type FreezeSafetyLivenessReport,
  type FreezeSafetyLivenessWatch,
  watchFreezeSafetyLiveness
} from './helpers/freeze-safety-liveness'

const MAIN_TIMER_LATENESS_BUDGET_MS = 250
const RENDERER_HEARTBEAT_BUDGET_MS = 2_000
const UNRELATED_IPC_BUDGET_MS = 1_000
const ARM_DELAY_MS = 300
const FILESYSTEM_HOST_RECOVERY_DELAY_MS = 31_000

type GrokRefreshDiagnostics = {
  error: string
  settled: boolean
  settledAt: number
  startedAt: number
}

function releaseFifo(fifoPath: string): void {
  try {
    const descriptor = openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)
    closeSync(descriptor)
  } catch {
    // No reader is parked on the FIFO.
  }
}

async function scheduleAsyncMainOperation(
  electronApp: ElectronApplication,
  durationMs: number
): Promise<void> {
  await electronApp.evaluate(
    (_electron, args) => {
      const state = { settled: false }
      ;(
        globalThis as unknown as { __freezeSafetyAsyncOperation: typeof state }
      ).__freezeSafetyAsyncOperation = state
      setTimeout(() => {
        void new Promise<void>((resolve) => setTimeout(resolve, args.durationMs)).then(() => {
          state.settled = true
        })
      }, args.armDelayMs)
    },
    { armDelayMs: ARM_DELAY_MS, durationMs }
  )
}

async function scheduleMainThreadBlock(
  electronApp: ElectronApplication,
  durationMs: number
): Promise<void> {
  await electronApp.evaluate(
    (_electron, args) => {
      setTimeout(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, args.durationMs)
      }, args.armDelayMs)
    },
    { armDelayMs: ARM_DELAY_MS, durationMs }
  )
}

async function scheduleRendererThreadBlock(page: Page, durationMs: number): Promise<void> {
  await page.evaluate(
    ({ armDelayMs, blockMs }) => {
      window.setTimeout(() => {
        const endAt = performance.now() + blockMs
        while (performance.now() < endAt) {
          // Intentional positive control for the renderer heartbeat.
        }
      }, armDelayMs)
    },
    { armDelayMs: ARM_DELAY_MS, blockMs: durationMs }
  )
}

function expectChannelsArmed(report: FreezeSafetyLivenessReport): void {
  expect(report.mainLoop.ticks).toBeGreaterThan(5)
  expect(report.rendererHeartbeat.roundTrips).toBeGreaterThan(5)
  expect(report.unrelatedIpc.roundTrips).toBeGreaterThan(2)
  expect(report.unrelatedIpc.failures).toBe(0)
}

test('keeps main, renderer, and unrelated IPC live during a bounded async main operation', async ({
  electronApp,
  orcaPage
}) => {
  const watch = await watchFreezeSafetyLiveness(electronApp, orcaPage)
  try {
    await scheduleAsyncMainOperation(electronApp, 1_200)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const report = await watch.sample()

    expectChannelsArmed(report)
    expect(report.mainLoop.maxTimerLatenessMs).toBeLessThan(MAIN_TIMER_LATENESS_BUDGET_MS)
    expect(report.rendererHeartbeat.maxRoundTripMs).toBeLessThan(RENDERER_HEARTBEAT_BUDGET_MS)
    expect(report.unrelatedIpc.maxRoundTripMs).toBeLessThan(UNRELATED_IPC_BUDGET_MS)
    expect(
      await electronApp.evaluate(
        () =>
          (globalThis as unknown as { __freezeSafetyAsyncOperation: { settled: boolean } })
            .__freezeSafetyAsyncOperation.settled
      )
    ).toBe(true)
  } finally {
    await watch.stop()
  }
})

test('attributes a bounded main block without misclassifying the renderer', async ({
  electronApp,
  orcaPage
}) => {
  const watch = await watchFreezeSafetyLiveness(electronApp, orcaPage)
  try {
    await scheduleMainThreadBlock(electronApp, 1_300)
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    const report = await watch.sample()

    expectChannelsArmed(report)
    expect(report.mainLoop.maxTimerLatenessMs).toBeGreaterThan(MAIN_TIMER_LATENESS_BUDGET_MS)
    expect(report.unrelatedIpc.maxRoundTripMs).toBeGreaterThan(UNRELATED_IPC_BUDGET_MS)
    expect(report.rendererHeartbeat.maxRoundTripMs).toBeLessThan(RENDERER_HEARTBEAT_BUDGET_MS)
  } finally {
    await watch.stop()
  }
})

test('detects a bounded renderer block while the main loop stays live', async ({
  electronApp,
  orcaPage
}) => {
  const watch = await watchFreezeSafetyLiveness(electronApp, orcaPage)
  try {
    await scheduleRendererThreadBlock(orcaPage, 2_200)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const report = await watch.sample()

    expectChannelsArmed(report)
    expect(report.mainLoop.maxTimerLatenessMs).toBeLessThan(MAIN_TIMER_LATENESS_BUDGET_MS)
    expect(report.rendererHeartbeat.maxRoundTripMs).toBeGreaterThan(RENDERER_HEARTBEAT_BUDGET_MS)
    expect(report.unrelatedIpc.maxRoundTripMs).toBeLessThan(UNRELATED_IPC_BUDGET_MS)
  } finally {
    await watch.stop()
  }
})

test('keeps Grok status live and recovers after its auth path stalls', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform === 'win32', 'POSIX FIFO symptom gate runs on Linux and macOS')
  test.setTimeout(120_000)

  const homePath = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const grokDirectory = path.join(homePath, '.grok')
  const authPath = path.join(grokDirectory, 'auth.json')
  let watch: FreezeSafetyLivenessWatch | null = null
  let fifoCreated = false

  try {
    mkdirSync(grokDirectory, { recursive: true })
    writeFileSync(authPath, '{invalid-json')
    const degraded = await orcaPage.evaluate(async () => {
      await window.api.rateLimits.refreshGrok()
      return await window.api.grokAccounts.getStatus()
    })
    expect(degraded).toMatchObject({ stale: true, availability: 'unavailable' })

    rmSync(authPath)
    execFileSync('mkfifo', [authPath])
    fifoCreated = true
    expect(lstatSync(authPath).isFIFO()).toBe(true)
    watch = await watchFreezeSafetyLiveness(electronApp, orcaPage)

    await orcaPage.evaluate(() => {
      const diagnostics: GrokRefreshDiagnostics = {
        error: '',
        settled: false,
        settledAt: 0,
        startedAt: Date.now()
      }
      ;(
        window as unknown as { __grokRefreshDiagnostics?: GrokRefreshDiagnostics }
      ).__grokRefreshDiagnostics = diagnostics
      void window.api.rateLimits
        .refreshGrok()
        .catch((error: unknown) => {
          diagnostics.error = String(error)
        })
        .finally(() => {
          diagnostics.settled = true
          diagnostics.settledAt = Date.now()
        })
    })

    const startedAt = Date.now()
    const status = await Promise.race([
      orcaPage.evaluate(() => window.api.grokAccounts.getStatus()),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Grok status read blocked on its auth path')), 1_000)
      )
    ])
    expect(Date.now() - startedAt).toBeLessThan(UNRELATED_IPC_BUDGET_MS)
    expect(status).toMatchObject({ stale: true, availability: 'unavailable' })

    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const report = await watch.sample()
    expectChannelsArmed(report)
    expect(report.mainLoop.maxTimerLatenessMs).toBeLessThan(MAIN_TIMER_LATENESS_BUDGET_MS)
    expect(report.rendererHeartbeat.maxRoundTripMs).toBeLessThan(RENDERER_HEARTBEAT_BUDGET_MS)
    expect(report.unrelatedIpc.maxRoundTripMs).toBeLessThan(UNRELATED_IPC_BUDGET_MS)

    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            () =>
              (window as unknown as { __grokRefreshDiagnostics?: GrokRefreshDiagnostics })
                .__grokRefreshDiagnostics
          ),
        { timeout: 12_000 }
      )
      .toMatchObject({ error: '', settled: true })
    const refreshDiagnostics = await orcaPage.evaluate(
      () =>
        (window as unknown as { __grokRefreshDiagnostics: GrokRefreshDiagnostics })
          .__grokRefreshDiagnostics
    )
    expect(refreshDiagnostics.settledAt - refreshDiagnostics.startedAt).toBeGreaterThanOrEqual(
      4_000
    )
    expect(refreshDiagnostics.settledAt - refreshDiagnostics.startedAt).toBeLessThan(8_000)

    releaseFifo(authPath)
    rmSync(authPath)
    fifoCreated = false
    writeFileSync(
      authPath,
      JSON.stringify({
        'https://auth.x.ai': {
          key: 'expired-test-token',
          email: 'recovered@example.invalid',
          expires_at: '2000-01-01T00:00:00.000Z'
        }
      })
    )
    await new Promise((resolve) => setTimeout(resolve, FILESYSTEM_HOST_RECOVERY_DELAY_MS))
    const recovered = await orcaPage.evaluate(async () => {
      await window.api.rateLimits.refreshGrok()
      return await window.api.grokAccounts.getStatus()
    })
    expect(recovered).toMatchObject({
      stale: false,
      availability: 'ready',
      signedIn: true,
      email: 'recovered@example.invalid'
    })
  } finally {
    if (fifoCreated) {
      releaseFifo(authPath)
    }
    await watch?.stop()
    rmSync(grokDirectory, { recursive: true, force: true })
  }
})
