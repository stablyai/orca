import { expect, test } from './helpers/orca-app'

type CapabilityProbe = {
  calls: number
  gapsMs: number[]
  returnDurationsMs: number[]
  timer: number
}

test('PTY capability lookup keeps renderer JavaScript responsive while main is stalled', async ({
  electronApp,
  orcaPage
}) => {
  await orcaPage.evaluate(() => {
    const getCapabilities = window.api.pty.getAuthoritativeBufferSnapshotCapabilities
    if (!getCapabilities) {
      throw new Error('PTY snapshot capability API is unavailable')
    }
    const probe: CapabilityProbe = {
      calls: 0,
      gapsMs: [],
      returnDurationsMs: [],
      timer: 0
    }
    let previousTickAt = performance.now()
    probe.timer = window.setInterval(() => {
      const tickAt = performance.now()
      probe.gapsMs.push(tickAt - previousTickAt)
      previousTickAt = tickAt
      const callStartedAt = performance.now()
      void getCapabilities(['ssh:e2e@@pty-1']).catch(() => {})
      probe.returnDurationsMs.push(performance.now() - callStartedAt)
      probe.calls += 1
    }, 50)
    ;(window as typeof window & { __capabilityProbe?: CapabilityProbe }).__capabilityProbe = probe
  })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        () =>
          (window as typeof window & { __capabilityProbe?: CapabilityProbe }).__capabilityProbe
            ?.calls ?? 0
      )
    )
    .toBeGreaterThan(0)

  const mainBlockedMs = await electronApp.evaluate(() => {
    const startedAt = Date.now()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500)
    return Date.now() - startedAt
  })
  const metrics = await orcaPage.evaluate(() => {
    const probe = (window as typeof window & { __capabilityProbe?: CapabilityProbe })
      .__capabilityProbe
    if (!probe) {
      throw new Error('Capability probe missing')
    }
    clearInterval(probe.timer)
    return {
      calls: probe.calls,
      maxGapMs: Math.max(...probe.gapsMs),
      maxReturnDurationMs: Math.max(...probe.returnDurationsMs)
    }
  })

  console.log(
    `[pty-capability-main-stall] mainBlockedMs=${mainBlockedMs} calls=${metrics.calls} maxGapMs=${metrics.maxGapMs.toFixed(1)} maxReturnDurationMs=${metrics.maxReturnDurationMs.toFixed(1)}`
  )

  expect(mainBlockedMs).toBeGreaterThanOrEqual(1_400)
  expect(metrics.calls).toBeGreaterThanOrEqual(10)
  expect(metrics.maxGapMs).toBeLessThan(500)
  expect(metrics.maxReturnDurationMs).toBeLessThan(100)
})
