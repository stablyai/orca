// Measures what Orca's spinners cost the whole app, and fails when they cost a frame of their own.
import { _electron as electron } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { verifyRendering } from './verify-rendering.mjs'
import { sampleCpu } from './sample-cpu.mjs'

const { values } = parseArgs({
  options: {
    agents: { type: 'string', default: '2' },
    rounds: { type: 'string', default: '2' },
    'sample-ms': { type: 'string', default: '5000' },
    // Frame counts do not depend on machine load; CPU percentages do.
    'frames-only': { type: 'boolean', default: false },
    'verify-only': { type: 'boolean', default: false }
  }
})
const agents = Number(values.agents)
const rounds = Number(values.rounds)
const sampleMs = Number(values['sample-ms'])
const TRACE_MS = 5000
const SETTLE_MS = 1500

// Each scenario names the one it must not out-draw: indicators may never add a redraw.
const SCENARIOS = {
  idle: { agents: 0 },
  'label only': { agents: 0, label: 'ticking' },
  'working, nothing else changing': { agents, baseline: 'idle' },
  'working, just mounted': { agents, baseline: 'idle', fresh: true },
  'working + label that does not change': { agents, label: 'quiet', baseline: 'idle' },
  'working + ticking label': { agents, label: 'ticking', baseline: 'label only' },
  'working scrolled away + ticking label': {
    agents,
    label: 'ticking',
    offset: 5000,
    baseline: 'label only'
  },
  'before: working + ticking label': { agents, label: 'ticking', legacy: true }
}
// Mounting anything draws a frame or two; allow that, nothing sustained.
const MOUNT_REDRAWS = 3

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const outputParent = path.join(root, '.bench-fixtures')
mkdirSync(outputParent, { recursive: true })
const outputDir = mkdtempSync(path.join(outputParent, 'spinner-rendering-'))
const main = path.join(outputDir, 'main.cjs')
await buildMain({
  entryPoints: [path.join(import.meta.dirname, 'main.ts')],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron']
})
await buildRenderer({
  configFile: false,
  root: import.meta.dirname,
  base: './',
  logLevel: 'silent',
  plugins: [tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src', 'renderer', 'src') } },
  build: { outDir: path.join(outputDir, 'renderer'), emptyOutDir: true }
})
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
const app = await electron.launch({
  args: [main],
  env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' }
})
const report = { scenarios: {}, failures: [] }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mean = (list) => list.reduce((total, value) => total + value, 0) / list.length
const perSecond = (count) => +((count * 1000) / TRACE_MS).toFixed(1)

try {
  const page = await app.firstWindow()
  await page.goto(pathToFileURL(path.join(outputDir, 'renderer', 'index.html')).href)
  await page.waitForFunction(() => Boolean(window.spinnerBenchmark))
  report.versions = await app.evaluate(() => process.versions)
  report.rendering = await verifyRendering(app, page)
  console.log(`Rendering checks passed: ${JSON.stringify(report.rendering)}`)
  if (!values['verify-only']) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const mount = (name) => {
      const { baseline: _baseline, fresh: _fresh, ...scenario } = SCENARIOS[name]
      return page.evaluate((value) => window.spinnerBenchmark.render(value), scenario)
    }
    const show = async (name) => {
      await mount(name)
      await pause(SETTLE_MS)
    }
    const countFrames = () =>
      app.evaluate((_electron, ms) => globalThis.spinnerBenchmarkCountFrames(ms), TRACE_MS)
    for (const name of Object.keys(SCENARIOS)) {
      let frames
      if (SCENARIOS[name].fresh) {
        // Trace first, then mount, so the mount and first paints are inside the measurement.
        await show('idle')
        const tracing = countFrames()
        await pause(500)
        await mount(name)
        frames = await tracing
      } else {
        await show(name)
        frames = await countFrames()
      }
      const census = await page.evaluate(() => window.spinnerBenchmark.census())
      report.scenarios[name] = {
        frames,
        spinners: census.length,
        runningSpinners: census.filter((spinner) => spinner.playState === 'running').length,
        cpu: [],
        mainThread: []
      }
    }
    if (!values['frames-only']) {
      for (let round = 0; round < rounds; round++) {
        // Alternate direction so drift (thermal, background load) does not favour one scenario.
        const order = Object.keys(SCENARIOS)
        for (const name of round % 2 === 0 ? order : order.toReversed()) {
          await show(name)
          const sample = await sampleCpu(app, cdp, sampleMs)
          report.scenarios[name].cpu.push(
            sample.cpuMsPerSecond.reduce((total, row) => total + (row.value ?? 0), 0) / 10
          )
          // Guards the typing stalls a 12 Hz style-writing spinner clock once caused (#12359).
          report.scenarios[name].mainThread.push(sample.rendererMsPerSecond.TaskDuration)
        }
      }
    }

    const at = (name) => report.scenarios[name]
    const idleCpu = at('idle').cpu.length ? mean(at('idle').cpu) : null
    console.table(
      Object.fromEntries(
        Object.entries(report.scenarios).map(([name, row]) => [
          name,
          {
            spinners: row.spinners,
            running: row.runningSpinners,
            'window redraws/s': perSecond(row.frames.displayDraws),
            'compositor ticks/s': perSecond(row.frames.compositorTicks),
            'main frames/s': perSecond(row.frames.mainFrames),
            ...(idleCpu === null
              ? {}
              : {
                  'app CPU %': +mean(row.cpu).toFixed(2),
                  'CPU over idle': +(mean(row.cpu) - idleCpu).toFixed(2),
                  'main thread ms/s': +mean(row.mainThread).toFixed(1)
                })
          }
        ])
      )
    )

    // The budget, in window redraws over the trace. One redraw of slack absorbs a stray frame.
    const draws = (name) => at(name).frames.displayDraws
    const expect = (ok, message) => ok || report.failures.push(message)
    for (const [name, { baseline, fresh }] of Object.entries(SCENARIOS)) {
      if (!baseline) {
        continue
      }
      expect(at(name).runningSpinners === 0, `${name}: an indicator animation is running`)
      const extra = draws(name) - draws(baseline) - (fresh ? MOUNT_REDRAWS : 0)
      expect(extra <= 1, `${name}: indicators cost ${extra} window redraws of their own`)
    }
    // The harness must be able to see the cost it guards against.
    expect(
      draws('before: working + ticking label') >= 5 * Math.max(1, draws('working + ticking label')),
      'the free-running baseline no longer shows a cost; the measurement is broken'
    )
  }
} finally {
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Spinner evidence: ${outputDir}`)
  await app.close()
}
if (report.failures.length > 0) {
  console.error(`Spinner budget exceeded:\n- ${report.failures.join('\n- ')}`)
  process.exit(1)
}
console.log('Spinner budget met: indicators add no window redraws of their own.')
