import { _electron as electron, expect } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Requires ORCA_BACKGROUND_LAUNCH=1')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const output = mkdtempSync(path.join(parent, 'omp-remote-sidebar-'))
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
  scope:
    'Production selector, row builder and compact sidebar rows; injected status with no tabs, then status removal. No live SSH/paired transport or full Orca shell.'
}
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error)
  })
  await page.goto(pathToFileURL(path.join(output, 'renderer/index.html')).href)
  await expect(page.getByText('Paired OMP finished the change')).toBeVisible()
  await expect(page.getByText('SSH OMP finished the change')).toBeVisible()
  await expect(page.getByText('Local completed orphan')).toHaveCount(0)
  const cdp = await page.context().newCDPSession(page)
  const capture = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64'))
  }
  await capture('remote-rows-before-tab-hydration')
  await page.evaluate(() => window.sidebarProof.retract())
  await expect(page.getByText('No agent activity')).toBeVisible()
  await expect(page.getByText('Paired OMP finished the change')).toHaveCount(0)
  await expect(page.getByText('SSH OMP finished the change')).toHaveCount(0)
  await capture('after-status-retraction')
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
  console.log(`OMP sidebar evidence: ${output}`)
  await app.close()
}
