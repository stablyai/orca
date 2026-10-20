import { _electron as electron } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Requires ORCA_BACKGROUND_LAUNCH=1')
}
const label = process.argv[2]
if (label !== 'before' && label !== 'after') {
  throw new Error('Usage: run.mjs <before|after>')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = path.join(root, '.bench-fixtures', `url-trailing-punctuation-${label}`)
mkdirSync(output, { recursive: true })
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
  build: { outDir: path.join(output, 'renderer'), emptyOutDir: true }
})

const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
const app = await electron.launch({ args: [main], env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' } })
const report = {
  label,
  scope:
    'Production CommentMarkdown and production createPaneDOM (real WebLinksAddon wiring) render one Japanese sentence; hidden Electron fixture, no full shell.'
}
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${pathToFileURL(path.join(output, 'renderer/index.html')).href}?label=${label}`)
  await page.waitForSelector('.xterm-rows')

  // Hover the middle of the URL with a real mouse event so xterm's linkifier
  // and the pane's own tooltip callback run exactly as they do in the app.
  const target = await page.evaluate(() => {
    const host = document.querySelector('[data-proof-terminal]')
    const rows = host.querySelector('.xterm-rows')
    const box = rows.getBoundingClientRect()
    const cellWidth = box.width / Number(host.dataset.cols)
    const cellHeight = box.height / Number(host.dataset.rows)
    // The Japanese prefix is 19 double-width glyphs, so the URL starts at cell
    // 40; aim at its middle rather than at a character offset.
    const column = 60
    return { x: box.left + (column + 0.5) * cellWidth, y: box.top + 0.5 * cellHeight }
  })
  await page.mouse.move(target.x, target.y)
  await page.waitForTimeout(400)

  report.nativeChatHrefHalfWidth = await page.textContent(
    '[data-proof="href the click opens (half-width brackets)"]'
  )
  report.nativeChatHrefFullWidth = await page.textContent(
    '[data-proof="href the click opens (full-width brackets)"]'
  )
  report.terminalUri = await page.textContent('[data-proof="uri the hover reports"]')
  const cdp = await page.context().newCDPSession(page)
  const { data: png } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(output, `${label}.png`), Buffer.from(png, 'base64'))
  report.pageErrors = errors
  report.windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  if (!report.windows.every((window) => !window.visible && !window.focused)) {
    throw new Error('A fixture window became visible or focused')
  }
} finally {
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  console.log(`screenshot: ${path.join(output, `${label}.png`)}`)
  await app.close()
}
