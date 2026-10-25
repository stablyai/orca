import { _electron as electron, expect } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const output = mkdtempSync(path.join(parent, 'conversation-reference-'))
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
const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
const app = await electron.launch({
  ...(process.env.ORCA_RENDERED_ELECTRON_PATH
    ? { executablePath: process.env.ORCA_RENDERED_ELECTRON_PATH }
    : {}),
  args: [main],
  env
})
try {
  const page = await app.firstWindow()
  const cdp = await page.context().newCDPSession(page)
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(pathToFileURL(path.join(output, 'renderer/index.html')).href)
  const input = page.getByRole('textbox')
  const sourceRow = page.getByTestId('source').locator('.compact-agent-row')
  const historyRow = page.getByTestId('history').locator('.group\\/session-row')
  const references = page.locator('[data-native-chat-conversation-reference]')
  const capture = async (name) => {
    await expect
      .poll(() => page.getByRole('menu').evaluate((element) => getComputedStyle(element).opacity))
      .toBe('1')
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    })
    writeFileSync(path.join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'))
    writeFileSync(
      path.join(output, `${name}-ax.json`),
      JSON.stringify(await cdp.send('Accessibility.getFullAXTree'))
    )
  }
  await input.fill('Keep the existing draft. ')
  await sourceRow.click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: 'Reference conversation', exact: true })
  ).toBeVisible()
  await expect(page.getByTestId('workspace-menus')).toHaveText('0')
  await capture('sidebar-menu')
  await page.getByRole('menuitem', { name: 'Reference conversation', exact: true }).click()
  await expect(references).toHaveCount(1)
  await expect(input).toContainText('Keep the existing draft.')
  await historyRow
    .getByText('Cursor history conversation', { exact: true })
    .click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: 'Copy conversation reference', exact: true })
  ).toBeVisible()
  await capture('history-context-menu')
  await page.getByRole('menuitem', { name: 'Reference conversation', exact: true }).click()
  await expect(references).toHaveCount(2)
  await historyRow.getByTestId('ai-vault-session-more-actions').click()
  await expect(
    page.getByRole('menuitem', { name: 'Copy conversation reference', exact: true })
  ).toBeVisible()
  await capture('history-overflow-menu')
  await page.getByRole('menuitem', { name: 'Reference conversation', exact: true }).click()
  await expect(references).toHaveCount(3)
  await page.getByTestId('source').locator('[draggable="true"]').dragTo(page.getByRole('textbox'))
  await expect(references).toHaveCount(4)
  const chip = page.locator('[data-native-chat-conversation-reference]').first()
  await expect(chip).toHaveText('Claude Code conversation')
  await page
    .getByTestId('history')
    .locator('[draggable="true"]')
    .first()
    .dragTo(page.getByRole('textbox'))
  await expect(references).toHaveCount(5)
  await expect(page.locator('[data-native-chat-conversation-reference]').last()).toHaveText(
    'Cursor history conversation'
  )
  await historyRow.getByTestId('ai-vault-session-toggle-details').click()
  await expect(historyRow.getByText('Original history question.', { exact: true })).toBeVisible()
  await historyRow.locator('[draggable="true"]').first().dragTo(input)
  await expect(references).toHaveCount(6)
  await expect(input).toContainText('Keep the existing draft.')
  await expect(page.getByTestId('resumed')).toHaveText('0')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('sent')).toContainText('orca-conversation://reference/')
  await expect(page.getByTestId('sent')).toContainText('orca conversation read')
  await chip.click()
  await expect(page.getByRole('dialog')).toContainText(
    'The earlier conversation contains this source answer.'
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  for (const theme of ['dark', 'light']) {
    await page.evaluate(
      (value) => document.documentElement.classList.toggle('dark', value === 'dark'),
      theme
    )
    for (const width of [1100, 430]) {
      await page.setViewportSize({ width, height: 720 })
      const base64 = await app.evaluate(
        async ({ BrowserWindow }, viewport) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.setSize(viewport.width, viewport.height)
          const image = await window.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true
          })
          return image.toPNG().toString('base64')
        },
        { width, height: 720 }
      )
      const screenshot = Buffer.from(base64, 'base64')
      writeFileSync(path.join(output, `${theme}-${width}.png`), screenshot)
      const bitmap = PNG.sync.read(screenshot)
      const colors = new Set()
      for (let at = 0; at < bitmap.data.length; at += 16) {
        colors.add(bitmap.data.subarray(at, at + 4).toString('hex'))
      }
      expect(colors.size).toBeGreaterThan(8)
      const dimensions = await page
        .getByTestId('composer')
        .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }))
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width)
    }
  }
  expect(errors).toEqual([])
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => [window.isVisible(), window.isFocused()])
    )
  ).toEqual([[false, false]])
  console.log(
    `PASS: actual sidebar context menu, history context/overflow menus, collapsed/expanded history pointer drags, preserved draft, no resume, reference preview, hidden windows; screenshots: ${output}`
  )
} finally {
  await app.close()
}
