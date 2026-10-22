import { _electron as electron, expect } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const output = mkdtempSync(path.join(parent, 'editor-git-blame-'))
const home = path.join(output, 'home')
mkdirSync(home)
const relativePath = 'src/shared/repo-kind.ts'
const filePath = path.join(root, relativePath)
const fixtureInput = {
  filePath,
  relativePath,
  content: readFileSync(filePath, 'utf8'),
  stdout: execFileSync('git', ['blame', '--porcelain', '--', relativePath], {
    cwd: root,
    encoding: 'utf8'
  })
}
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
  scope: 'Production MonacoEditor in hidden Electron; real git blame porcelain',
  errors: []
}
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => report.errors.push(error.message))
  await page.addInitScript((value) => {
    window.__BLAME_FIXTURE__ = value
  }, fixtureInput)
  await page.goto(pathToFileURL(path.join(output, 'renderer/index.html')).href)
  await expect(page.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 20_000 })
  await page.locator('.monaco-editor .view-line').nth(2).click()
  const annotation = page.locator('.orca-git-blame-inline')
  // Why one element: a second means the annotation wrapped onto an extra visual row.
  await expect(annotation).toHaveCount(1, { timeout: 10_000 })
  report.annotation = await annotation.textContent()
  report.blameCalls = await page.evaluate(() => window.__BLAME_CALLS__)
  await page.screenshot({ path: path.join(output, 'inline-blame.png') })
  // Why mouse coordinates: Monaco re-renders injected text, so locator.hover() never sees it as stable.
  const box = await annotation.boundingBox()
  report.annotationBox = box
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2)
  const hover = page
    .locator('.monaco-hover-content')
    .filter({ hasText: /\b[0-9a-f]{8}\b/ })
    .first()
  await expect(hover).toBeVisible({ timeout: 10_000 })
  report.hover = await hover.innerText()
  report.hidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  expect(report.hidden).toBe(true)
  report.passed = true
} finally {
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(output)
  await app.close()
}
