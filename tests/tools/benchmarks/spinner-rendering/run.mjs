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
const scaleArgs = values['scale-factor']
  ? [`--force-device-scale-factor=${values['scale-factor']}`]
  : []
const app = await electron.launch({
  args: [...scaleArgs, main],
  env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' }
})
const report = { samples: [] }
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
