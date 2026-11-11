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
const output = mkdtempSync(path.join(parent, 'omp-child-history-'))
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
    'Production virtual history list and nested rows with injected records; hidden Electron/CDP layout and action targeting, not full launch UI.'
}
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error)
  })
  await page.goto(pathToFileURL(path.join(output, 'renderer/index.html')).href)
  await page.getByTestId('ai-vault-session-toggle-details').first().click()
  await expect(page.getByText('OMP worker with saved conversation')).toBeVisible()
  expect(await page.evaluate(() => window.nestedRequests.length)).toBe(1)
  const cdp = await page.context().newCDPSession(page)
  const capture = async (name) => {
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {}))
      )
    })
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64'))
  }
  await capture('child-resume-affordance')
  await page
    .getByText('OMP worker with saved conversation')
    .locator('..')
    .getByRole('button', { name: 'Resume in Worktree' })
    .click()
  await expect(page.getByText('Resume child in folder:project')).toBeVisible()
  await capture('child-resume-callback')
  for (let depth = 2; depth <= 8; depth++) {
    const row =
      depth === 2
        ? page.getByText('OMP worker with saved conversation')
        : page.getByText(`Research depth ${depth - 1}`, { exact: true })
    await row.locator('..').getByRole('button', { name: 'Subagents (1)' }).click()
    await expect(page.getByText(`Research depth ${depth}`, { exact: true })).toBeVisible()
    if (depth === 2) {
      await capture('grandchild-disclosure-dark')
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await capture('grandchild-disclosure-light')
      await page.evaluate(() => document.documentElement.classList.add('dark'))
    }
  }
  await page
    .getByText('Research depth 8', { exact: true })
    .locator('..')
    .getByRole('button', { name: 'Resume in Worktree' })
    .click()
  await expect(page.getByText('Resume depth-6 in folder:project')).toBeVisible()
  const scroll = page.locator('.overflow-y-auto').first()
  const checkLayout = async () => {
    const layout = await page.locator('[data-index="1"]').evaluate((element) => {
      const next = document.querySelector('[data-index="2"]')
      return {
        height: element.getBoundingClientRect().height,
        bottom: element.getBoundingClientRect().bottom,
        nextTop: next?.getBoundingClientRect().top
      }
    })
    expect(layout.nextTop).toBeGreaterThanOrEqual(layout.bottom - 1)
    return layout
  }
  await expect
    .poll(async () => {
      const bounds = await page.locator('[data-index="1"]').boundingBox()
      const next = await page.locator('[data-index="2"]').boundingBox()
      return next.y - bounds.y - bounds.height
    })
    .toBeGreaterThanOrEqual(-1)
  report.expandedLayout = await checkLayout()
  const lefts = await page
    .getByText(/^Research depth /)
    .evaluateAll((elements) =>
      elements.map((element) => element.parentElement.getBoundingClientRect().left)
    )
  expect(lefts.at(-1)).toBe(lefts.at(-2))
  report.depthLefts = lefts
  await capture('nested-expanded')
  report.sidebarWidths = []
  for (const width of [280, 350]) {
    await page.getByTestId('history-panel').evaluate((element, value) => {
      element.style.width = `${value}px`
    }, width)
    const measurements = await page.getByText(/^Research depth /).evaluateAll((elements) =>
      elements.map((element) => {
        const row = element.parentElement
        const bounds = row.getBoundingClientRect()
        return {
          titleWidth: element.getBoundingClientRect().width,
          rowRight: bounds.right,
          buttonsRight: Math.max(
            ...[...row.querySelectorAll('button')].map(
              (button) => button.getBoundingClientRect().right
            )
          )
        }
      })
    )
    expect(
      measurements.every((row) => row.titleWidth >= 40 && row.buttonsRight <= row.rowRight + 1)
    ).toBe(true)
    report.sidebarWidths.push({ width, measurements })
    await page.getByText('Research depth 4', { exact: true }).scrollIntoViewIfNeeded()
    await capture(`nested-width-${width}`)
  }
  await page.getByTestId('history-panel').evaluate((element) => {
    element.style.width = ''
  })

  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(page.getByText('OMP worker with saved conversation')).toHaveCount(0)
  await scroll.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(page.getByText('Research depth 8', { exact: true })).toBeVisible()
  await page
    .getByText('OMP worker with saved conversation')
    .locator('..')
    .getByRole('button', { name: 'Subagents (1)' })
    .click()
  await expect(page.getByText('Research depth 8', { exact: true })).toHaveCount(0)
  await expect
    .poll(async () => {
      const bounds = await page.locator('[data-index="1"]').boundingBox()
      return bounds.height
    })
    .toBeLessThan(report.expandedLayout.height)
  await expect
    .poll(async () => {
      const bounds = await page.locator('[data-index="1"]').boundingBox()
      const next = await page.locator('[data-index="2"]').boundingBox()
      return Math.abs(next.y - bounds.y - bounds.height)
    })
    .toBeLessThanOrEqual(1)
  report.collapsedLayout = await checkLayout()
  report.requests = await page.evaluate(() => window.nestedRequests)
  await capture('nested-collapsed')
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
  console.log(`OMP child history evidence: ${output}`)
  await app.close()
}
