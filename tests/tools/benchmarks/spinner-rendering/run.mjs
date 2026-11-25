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
import { traceIterations } from './trace-iterations.mjs'

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '200' },
    'sample-ms': { type: 'string', default: '5000' },
    'scale-factor': { type: 'string' },
    'verify-only': { type: 'boolean', default: false }
  }
})
const count = Number(values.count)
const sampleMs = Number(values['sample-ms'])
if (!Number.isInteger(count) || count < 1 || !Number.isFinite(sampleMs) || sampleMs < 1000) {
  throw new Error('Use a positive integer --count and --sample-ms >= 1000')
}
const scaleFactor = values['scale-factor']
// Absent means the display's own scale; a present but unusable value must not silently fall back to it.
if (
  scaleFactor !== undefined &&
  !(scaleFactor.trim() !== '' && Number.isFinite(Number(scaleFactor)) && Number(scaleFactor) > 0)
) {
  throw new Error(`Use a positive number for --scale-factor (got "${scaleFactor}")`)
}
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
const scaleArgs =
  scaleFactor === undefined ? [] : [`--force-device-scale-factor=${Number(scaleFactor)}`]
const app = await electron.launch({
  args: [...scaleArgs, main],
  env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' }
})
const report = { samples: [], frames: {}, failures: [] }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  const page = await app.firstWindow()
  await page.goto(pathToFileURL(path.join(outputDir, 'renderer', 'index.html')).href)
  await page.waitForFunction(() => Boolean(window.spinnerBenchmark))
  report.versions = await app.evaluate(() => process.versions)
  report.rendering = await verifyRendering(app, page, outputDir)
  console.log(`Rendering checks passed: ${JSON.stringify(report.rendering)}`)
  if (!values['verify-only']) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    // Redraw gate: running rings may draw at their own step rate, never on the main thread or while scrolled away.
    const FRAME_SCENARIOS = {
      idle: { count: 0 },
      visible: { count },
      'scrolled away': { count, offset: 5000 },
      'baseline visible': { count, baseline: true }
    }
    for (const [name, options] of Object.entries(FRAME_SCENARIOS)) {
      await page.evaluate((value) => window.spinnerBenchmark.render(value), options)
      await pause(1000)
      report.frames[name] = await traceIterations(
        cdp,
        path.join(outputDir, `trace-${name.replaceAll(' ', '-')}.json`),
        5000
      )
      console.log(`${name}: ${JSON.stringify(report.frames[name])}`)
    }
    const frames = report.frames
    const expect = (ok, message) => ok || report.failures.push(message)
    // The harness must see a running ring, or the limits below prove nothing.
    expect(
      frames['baseline visible'].windowRedrawsPerSecond >= 8,
      'a visible 12-step ring drew under 8 window redraws/s; the measurement is broken (a hidden window draws no frames on some hosts, e.g. Windows)'
    )
    // 12 steps/s plus slack for a stray frame.
    expect(
      frames.visible.windowRedrawsPerSecond <= frames.idle.windowRedrawsPerSecond + 14,
      'visible rings redraw the window faster than their 12 steps/s'
    )
    expect(
      frames.visible.mainFramesPerSecond <= frames.idle.mainFramesPerSecond + 2,
      'visible rings run main-thread frames; they must stay on the compositor'
    )
    for (const metric of ['windowRedrawsPerSecond', 'mainFramesPerSecond']) {
      expect(
        frames['scrolled away'][metric] <= frames.idle[metric] + 1,
        `scrolled-away rings still cost ${metric} over idle`
      )
    }
    for (const total of [0, ...new Set([1, count])]) {
      for (const offset of total === 0 ? [0] : [0, 5000]) {
        // Interleave A/B/B/A to reduce temperature and background-load bias.
        for (const baseline of total === 0 ? [true] : [true, false, false, true]) {
          await page.evaluate((options) => window.spinnerBenchmark.render(options), {
            count: total,
            offset,
            baseline
          })
          await pause(1000)
          const sample = {
            count: total,
            offset,
            baseline,
            ...(await sampleCpu(app, cdp, sampleMs))
          }
          report.samples.push(sample)
          console.log(JSON.stringify(sample))
        }
      }
    }
  }
} finally {
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Spinner evidence: ${outputDir}`)
  await app.close()
}
if (report.failures.length > 0) {
  console.error(`Spinner redraw gate failed:\n- ${report.failures.join('\n- ')}`)
  process.exit(1)
}
