import { _electron as electron, expect } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1' || !process.argv[2]) {
  throw new Error('Requires ORCA_BACKGROUND_LAUNCH=1 and the runtime smoke JSON path')
}
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (!Array.isArray(data.transcripts) || data.transcripts.length !== 4) {
  throw new Error('Expected four actual OMP transcript reader results')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const output = mkdtempSync(path.join(parent, 'omp-transcript-'))
const main = path.join(output, 'main.cjs')
await buildMain({
  entryPoints: [path.join(root, 'tests/tools/benchmarks/spinner-rendering/main.ts')],
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
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src/renderer/src') } },
  define: { __TRANSCRIPT_PROOF__: JSON.stringify(data) },
  build: { outDir: path.join(output, 'renderer'), emptyOutDir: true }
})
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
const app = await electron.launch({ args: [main], env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' } })
const report = {
  scope:
    'Production desktop message list renders actual OMP SessionManager transcripts read through Orca; hidden Electron fixture, no full shell or model turn.',
  results: []
}
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const cdp = await page.context().newCDPSession(page)
  for (const [index, transcript] of data.transcripts.entries()) {
    await page.goto(
      `${pathToFileURL(path.join(output, 'renderer/index.html')).href}?index=${index}`
    )
    await expect(
      page.getByText(`Transcript proof ${transcript.kind} ${transcript.phase}`, { exact: true })
    ).toBeVisible()
    const { data: png } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      path.join(output, `${transcript.kind}-${transcript.phase}.png`),
      Buffer.from(png, 'base64')
    )
    report.results.push({
      producer: transcript.kind,
      phase: transcript.phase,
      messages: transcript.messages.length,
      rendered: true
    })
  }
  expect(errors).toEqual([])
  report.windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(report.windows.every((window) => !window.visible && !window.focused)).toBe(true)
} finally {
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`OMP transcript evidence: ${output}`)
  await app.close()
}
