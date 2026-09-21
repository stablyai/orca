import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForTerminalOutputForPtyId } from './artificial-opencode-pane-interactions'
import { measurePacedTyping, type PacedTypingMeasurement } from './paced-terminal-typing'
import {
  typingProbeReadyMarker,
  writeTypingEchoProbeScript
} from './sustained-agent-typing-load-scripts'

// File scope, not the test body: a body-level skip still builds the Electron fixtures.
test.skip(process.env.ORCA_TYPING_BENCH !== '1', 'Opt-in benchmark calibration')

test('typing measurement charges known renderer stalls to the planned schedule', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const reports: {
    injectStall: boolean
    counts: { keys: number; stalls: number }
    measurement: PacedTypingMeasurement
  }[] = []
  for (const injectStall of [false, true]) {
    const runId = randomUUID()
    const script = path.join(testRepoPath, `typing-control-${runId}.mjs`)
    const sidecar = path.join(testRepoPath, `typing-control-${runId}.jsonl`)
    writeTypingEchoProbeScript(script, runId, sidecar)
    await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(script)}\r`)
    await waitForTerminalOutputForPtyId(orcaPage, ptyId, typingProbeReadyMarker(runId), 15_000)
    const control = await orcaPage.evaluateHandle((enabled) => {
      let keys = 0
      let stalls = 0
      const handler = (event: KeyboardEvent): void => {
        if (event.key.length !== 1) {
          return
        }
        keys += 1
        if (!enabled || keys % 4 !== 0) {
          return
        }
        stalls += 1
        const until = performance.now() + 120
        while (performance.now() < until) {
          /* Known blocking positive control. */
        }
      }
      window.addEventListener('keydown', handler, true)
      return {
        stop: () => {
          window.removeEventListener('keydown', handler, true)
          return { keys, stalls }
        }
      }
    }, injectStall)
    try {
      const measurement = await measurePacedTyping(orcaPage, runId, sidecar, {
        keyCount: 32,
        keyCadenceMs: 25
      })
      const counts = await control.evaluate((value) => value.stop())
      reports.push({ injectStall, counts, measurement })
      expect(counts.keys).toBe(32)
      if (injectStall) {
        expect(counts.stalls).toBe(8)
        expect(measurement.inputHalfMs?.p90).toBeGreaterThanOrEqual(110)
        expect(measurement.dispatchDelayMs?.max).toBeGreaterThanOrEqual(70)
        expect(measurement.plannedToPtyArrivalMs?.max).toBeGreaterThanOrEqual(120)
      }
    } finally {
      await control.evaluate((value) => value.stop())
      await control.dispose()
      await sendToTerminal(orcaPage, ptyId, '\x03')
      rmSync(script, { force: true })
      rmSync(sidecar, { force: true })
    }
  }
  const directory = path.resolve(__dirname, '..', 'tools', 'benchmarks', 'results')
  mkdirSync(directory, { recursive: true })
  const reportPath = path.join(directory, `typing-measurement-control-${Date.now()}.json`)
  writeFileSync(reportPath, JSON.stringify(reports, null, 2))
  await testInfo.attach('measurement-control', {
    path: reportPath,
    contentType: 'application/json'
  })
})
