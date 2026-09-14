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
const output = mkdtempSync(path.join(parent, 'omp-pending-input-'))
const main = path.join(output, 'main.cjs')
// Reuse the existing isolated, hidden Electron renderer host.
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
    'Real desktop message list and interaction cards in a hidden Electron fixture; injected prompt state, no provider/model execution.',
  checks: []
}
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(error))
  const cdp = await page.context().newCDPSession(page)
  const screenshot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const url = pathToFileURL(path.join(output, 'renderer/index.html')).href
  for (const baseline of [true, false]) {
    await page.goto(`${url}${baseline ? '?baseline' : ''}`)
    await page.waitForFunction(() => Boolean(window.pendingInputProof))
    const activity = page.locator('[data-native-chat-turn-activity]')
    await expect(activity).toBeVisible()
    const startedAt = await page.locator('main').getAttribute('data-started-at')
    for (const kind of ['question', 'approval']) {
      await page.evaluate((kind) => window.pendingInputProof.setPending(kind), kind)
      await expect(page.getByText('Waiting for your response')).toBeVisible()
      await expect(activity).toHaveCount(baseline ? 1 : 0)
      await expect(page.locator('main')).toHaveAttribute('data-working', 'true')
      await screenshot(`${baseline ? 'before' : 'after'}-${kind}`)
      if (kind === 'question') {
        await page.getByRole('button', { name: /Spaces/ }).click()
        await page.getByRole('button', { name: 'Submit', exact: true }).click()
      } else {
        await page.getByRole('button', { name: 'Allow', exact: true }).click()
      }
      await expect(activity).toBeVisible()
      await expect(page.locator('main')).toHaveAttribute('data-started-at', startedAt)
      await expect(page.getByText('Waiting for your response')).toHaveCount(0)
      await expect(page.locator('[data-answer]')).not.toHaveAttribute('data-answer', '')
      await screenshot(`${baseline ? 'before' : 'after'}-${kind}-resumed`)
      report.checks.push({
        baseline,
        kind,
        pendingActivityCount: baseline ? 1 : 0,
        resumed: true,
        retainedStart: true
      })
    }
    await page.evaluate(() => window.pendingInputProof.finish())
    await expect(activity).toHaveCount(0)
    await expect(page.getByText('Turn finished')).toBeVisible()
  }
  report.windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(report.windows.every((window) => !window.visible && !window.focused)).toBe(true)
} finally {
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`OMP pending input evidence: ${output}`)
  await app.close()
}
