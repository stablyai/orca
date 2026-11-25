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
const output = mkdtempSync(path.join(parent, 'jira-board-column-order-'))
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
    'Production TaskPageJiraBoard and its lane-order storage in a hidden Electron renderer with invented issues. Drag events are dispatched against the real handlers; no OS drag session and no Jira site are involved.'
}

async function laneOrder(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-label^="Reorder "]')].map((handle) =>
      (handle.getAttribute('aria-label') ?? '').replace('Reorder ', '')
    )
  )
}

async function capture(page, file) {
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => {}))
    )
  })
  const cdp = await page.context().newCDPSession(page)
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(output, file), Buffer.from(data, 'base64'))
}

try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error)
  })
  await page.goto(pathToFileURL(path.join(output, 'renderer/index.html')).href)
  await expect(page.getByRole('button', { name: 'Reorder To Do' })).toBeVisible()
  report.before = await laneOrder(page)
  await capture(page, 'before.png')

  // The same dragstart/dragover/drop the component sees from a mouse drag.
  await page.evaluate(
    ([moved, target]) => {
      const handle = (label) => document.querySelector(`[aria-label="Reorder ${label}"]`)
      const transfer = new DataTransfer()
      const fire = (element, type) =>
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })
        )
      fire(handle(moved), 'dragstart')
      fire(handle(target), 'dragover')
      fire(handle(target), 'drop')
    },
    ['Done', 'To Do']
  )

  await expect(page.locator('[aria-label^="Reorder "]').first()).toHaveAttribute(
    'aria-label',
    'Reorder Done'
  )
  report.after = await laneOrder(page)
  await capture(page, 'after.png')

  expect(report.after).toEqual(['Done', 'To Do', 'In Progress'])
  report.saved = await page.evaluate(() => localStorage.getItem('orca.jira.board-column-order.v1'))

  // A keyboard user can only repeat a move if focus follows the lane. Two presses in a
  // row prove it, in the browser rather than in a DOM shim.
  const keyboardLane = page.getByRole('button', { name: 'Reorder Done' })
  await keyboardLane.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  report.afterKeyboard = await laneOrder(page)
  report.keyboardFocus = await page.evaluate(() =>
    document.activeElement?.getAttribute('aria-label')
  )
  expect(report.afterKeyboard).toEqual(['To Do', 'In Progress', 'Done'])
  expect(report.keyboardFocus).toBe('Reorder Done')
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
  console.log(`Jira board column order evidence: ${output}`)
  await app.close()
}
