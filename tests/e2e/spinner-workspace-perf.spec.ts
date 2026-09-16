import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { sendToTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { measurePacedTyping } from './paced-terminal-typing'
import {
  typingProbeReadyMarker,
  writeTypingEchoProbeScript
} from './sustained-agent-typing-load-scripts'
import {
  createSpinnerRepository,
  refreshSpinnerAgents,
  seedSpinnerWorkspaces,
  startSpinnerStatusTraffic
} from './spinner-workspace-fixture'
import { collectRendererCensus } from '../../config/scripts/idle-cpu-renderer-scale-fixture.mjs'
import {
  setSpinnerVariant,
  spinnerCensus
} from '../tools/benchmarks/spinner-rendering/app-variants.mjs'
import { sampleCpu } from '../tools/benchmarks/spinner-rendering/sample-cpu.mjs'
import { traceIterations } from '../tools/benchmarks/spinner-rendering/trace-iterations.mjs'

const enabled = process.env.ORCA_SPINNER_BENCH === '1'
const sampleMs = Number(process.env.ORCA_SPINNER_SAMPLE_MS ?? 10000)
const rounds = Number(process.env.ORCA_SPINNER_ROUNDS ?? 4)
const keyCount = Number(process.env.ORCA_SPINNER_KEYS ?? 48)
// Avoid phase-locking keystrokes to the 200 ms status burst or 60 Hz frames.
const keyCadenceMs = Number(process.env.ORCA_SPINNER_KEY_CADENCE_MS ?? 113)
const variants = (process.env.ORCA_SPINNER_VARIANTS ?? 'original,long').split(',')
if (enabled) {
  for (const [name, value, minimum] of [
    ['sample duration', sampleMs, 1000],
    ['rounds', rounds, 1],
    ['keys', keyCount, 0],
    ['key cadence', keyCadenceMs, 1]
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`Invalid spinner benchmark ${name}: ${value}`)
    }
  }
}
const scenarios = [
  { name: 'one-agent', worktrees: 1, lineageDepth: 0, agentsPerWorktree: 1, subagentsPerAgent: 0 },
  { name: 'one-family', worktrees: 1, lineageDepth: 0, agentsPerWorktree: 2, subagentsPerAgent: 2 },
  { name: '200-flat', worktrees: 200, lineageDepth: 0, agentsPerWorktree: 2, subagentsPerAgent: 2 },
  {
    name: '200-lineage',
    worktrees: 200,
    lineageDepth: 2,
    agentsPerWorktree: 2,
    subagentsPerAgent: 2
  }
]

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ],
  trace: 'off',
  screenshot: 'off'
})
test.skip(!enabled, 'Opt-in performance benchmark')

for (const scenario of scenarios) {
  test(`spinner performance ${scenario.name}`, async ({
    electronApp,
    orcaPage: page,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.setTimeout(900_000)
    const output = path.resolve(process.env.ORCA_SPINNER_OUTPUT ?? '.bench-fixtures/spinner-app')
    mkdirSync(output, { recursive: true })
    const fixture = await createSpinnerRepository(scenario.worktrees)
    registerPostElectronShutdownCleanup(async () =>
      rmSync(fixture.directory, { recursive: true, force: true })
    )
    await waitForSessionReady(page)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.webContents.setBackgroundThrottling(false)
      window.setSize(1280, 900)
    })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const seeded = await seedSpinnerWorkspaces(page, fixture.repoPath, scenario)
    await ensureTerminalVisible(page)
    await page.waitForTimeout(10000)
    await expect(page.locator('[data-worktree-sidebar] [data-agent-spinner]').first()).toBeVisible()
    const census = await collectRendererCensus(page, scenario.lineageDepth)
    const rings = await spinnerCensus(page)
    expect(census.worktrees.store).toBe(scenario.worktrees)
    expect(census.agentRows.storeLive).toBeGreaterThanOrEqual(
      scenario.worktrees * scenario.agentsPerWorktree
    )
    if (scenario.subagentsPerAgent) {
      expect(rings.workingSubagentRows).toBeGreaterThan(0)
    }
    if (scenario.lineageDepth) {
      expect(census.worktrees.mountedUnique).toBe(scenario.worktrees)
    }
    const report = {
      benchmark: 'working-spinner-workspaces',
      createdAt: new Date().toISOString(),
      scenario,
      options: { sampleMs, rounds, keyCount, keyCadenceMs, variants },
      seeded,
      census,
      rings,
      versions: await electronApp.evaluate(() => process.versions),
      traces: [] as unknown[],
      samples: [] as unknown[],
      typing: [] as unknown[]
    }
    const save = () =>
      writeFileSync(
        path.join(output, `${scenario.name}.json`),
        `${JSON.stringify(report, null, 2)}\n`
      )
    save()
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        rings,
        mountedWorkspaces: census.worktrees.mountedUnique
      })
    )
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    for (let round = 0; round < (process.env.ORCA_SPINNER_CPU === '0' ? 0 : rounds); round++) {
      const order = round % 2 ? variants.toReversed() : variants
      for (const variant of order) {
        await setSpinnerVariant(page, variant)
        await refreshSpinnerAgents(page)
        await page.waitForTimeout(1500)
        const before = await spinnerCensus(page)
        const sample = { variant, round, before, ...(await sampleCpu(electronApp, cdp, sampleMs)) }
        const after = await spinnerCensus(page)
        expect(after.mounted).toBe(before.mounted)
        report.samples.push(sample)
        save()
        console.log(JSON.stringify({ scenario: scenario.name, ...sample }))
        if (round === rounds - 1) {
          const trace = await traceIterations(
            cdp,
            path.join(output, `${scenario.name}-${variant}-trace.json`)
          )
          report.traces.push({ variant, ...trace })
          save()
        }
      }
    }
    const ptyId = await waitForActivePanePtyId(page)
    for (let round = 0; round < Math.min(rounds, 2); round++) {
      for (const variant of round % 2 ? variants.toReversed() : variants) {
        if (keyCount === 0) {
          continue
        }
        await setSpinnerVariant(page, variant)
        await refreshSpinnerAgents(page)
        const runId = randomUUID()
        const scriptPath = path.join(fixture.repoPath, `spinner-typing-${runId}.mjs`)
        const sidecarPath = path.join(output, `typing-${runId}.jsonl`)
        writeTypingEchoProbeScript(scriptPath, runId, sidecarPath)
        await sendToTerminal(page, ptyId, `node ${path.basename(scriptPath)}\r`)
        await waitForTerminalOutput(page, typingProbeReadyMarker(runId), 15000)
        const traffic = await startSpinnerStatusTraffic(page)
        try {
          await page.waitForTimeout(2000)
          const measurement = await measurePacedTyping(page, runId, sidecarPath, {
            keyCount,
            keyCadenceMs
          })
          expect(measurement.missingEchoCount).toBe(0)
          expect(measurement.missingPtyArrivalCount).toBe(0)
          report.typing.push({ variant, round, measurement })
          save()
          console.log(
            JSON.stringify({
              scenario: scenario.name,
              variant,
              typing: measurement.totalMs,
              input: measurement.inputHalfMs
            })
          )
        } finally {
          await traffic.evaluate((probe) => probe.stop())
          await traffic.dispose()
          await sendToTerminal(page, ptyId, '\x03')
        }
      }
    }
    await setSpinnerVariant(page, 'long')
    await page.screenshot({ path: path.join(output, `${scenario.name}.png`) })
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      )
    ).toBe(true)
    await testInfo.attach('spinner-benchmark', {
      path: path.join(output, `${scenario.name}.json`),
      contentType: 'application/json'
    })
  })
}
