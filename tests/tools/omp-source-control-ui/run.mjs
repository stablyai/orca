import { _electron as electron, expect } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const output = mkdtempSync(path.join(parent, 'omp-source-control-'))
const home = path.join(output, 'home')
mkdirSync(home)
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
  plugins: [tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src/renderer/src') } },
  build: { outDir: path.join(output, 'renderer'), emptyOutDir: true }
})
const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
const app = await electron.launch({
  args: [main],
  env: { ...env, HOME: home, ZDOTDIR: home, ORCA_BACKGROUND_LAUNCH: '1' }
})
const report = {
  scope:
    'Production CommitMessageAiPane in hidden Electron; in-memory settings persistence; no generator invoked',
  errors: []
}
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => report.errors.push(error.message))
  await page.goto(pathToFileURL(path.join(output, 'renderer/index.html')).href)
  const firstAgent = page.getByRole('combobox').first()
  await expect(firstAgent).toBeVisible()
  await firstAgent.click()
  const omp = page.getByRole('option', { name: 'OMP', exact: true })
  await expect(omp).toBeVisible()
  await page.screenshot({ path: path.join(output, 'omp-selectable.png') })
  await omp.click()
  await expect(firstAgent).toContainText('OMP')
  const firstArgs = page.locator('input').first()
  await expect(firstArgs).toHaveValue('')
  await page.screenshot({ path: path.join(output, 'omp-configured-default.png') })
  await firstArgs.fill('--model provider/exact-model')
  const firstSave = page.getByRole('button', { name: 'Save', exact: true }).first()
  await firstSave.click()
  await expect(firstSave).toBeDisabled()
  await expect(firstArgs).toHaveValue('--model provider/exact-model')
  await page.screenshot({ path: path.join(output, 'omp-explicit-model-saved.png') })
  report.hidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  expect(report.hidden).toBe(true)
  expect(report.errors).toEqual([])
  report.passed = true
} finally {
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(output)
  await app.close()
}
