import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  dispatchTrackpadWheelStream,
  MAX_ARRIVAL_LAG_MS,
  readReportArrivalLog,
  startHeavyTuiFixture,
  summarizeArrivals,
  terminalWheelTarget,
  WHEEL_EVENTS
} from './terminal-tui-wheel-drain-support'

test.describe('terminal TUI wheel report drain', () => {
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
