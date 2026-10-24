import { _electron as electron, expect } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
expect(process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL).toBe('1')
const home = realpathSync(process.env.HOME)
const realHome = userInfo().homedir
expect(realHome === home || realHome.startsWith(home + path.sep)).toBe(false)
for (const name of [
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'APPDATA',
  'LOCALAPPDATA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ORCA_E2E_USER_DATA_DIR',
  'ORCA_E2E_HOME_DIR'
]) {
  const directory = realpathSync(process.env[name])
  expect(directory === home || directory.startsWith(home + path.sep), name).toBe(true)
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const reuse = process.argv[2]
const output = reuse ? realpathSync(reuse) : mkdtempSync(path.join(parent, 'native-chat-controls-'))
expect(path.dirname(output)).toBe(realpathSync(parent))
const main = path.join(output, 'main.cjs')
if (!reuse) {
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
}
const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
const app = await electron.launch({
  args: [main, '--password-store=basic', '--use-mock-keychain'],
  env
})
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const url = pathToFileURL(path.join(output, 'renderer/index.html')).href
  const search = page.getByRole('search')
  const next = page.getByRole('button', { name: 'Next match', exact: true })
  async function openFind() {
    await page.goto(url)
    await page.getByRole('button', { name: 'Open Find', exact: true }).click()
    await page.getByRole('textbox', { name: 'Find in chat', exact: true }).fill('alpha')
    await expect(search).toContainText('1/2')
  }
  // Regression 1: occupied header clears Find and its ordinary Next action works.
  await openFind()
  const header = await page.locator('.pane-title-bar').boundingBox()
  const bar = await search.boundingBox()
  expect(Math.min(header.width, header.height, bar.width, bar.height)).toBeGreaterThan(0)
  expect(bar.y).toBeGreaterThan(header.y + header.height)
  await next.click()
  await expect(search).toContainText('2/2')
  // Regression 2: a keyboard-held label overlaps Next, but the actual click reaches Next.
  await openFind()
  await page.getByRole('textbox', { name: 'Find in chat', exact: true }).press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: 'Split Chat Right', exact: true })).toBeFocused()
  const label = page.locator('[data-slot="tooltip-content"][data-state="instant-open"]')
  await expect(label).toBeVisible()
  const probe = await label.evaluate((content) => {
    const button = document.querySelector('button[aria-label="Next match"]')
    const wrapper = content.closest('[data-radix-popper-content-wrapper]')
    const b = button.getBoundingClientRect(),
      c = content.getBoundingClientRect(),
      w = wrapper.getBoundingClientRect()
    const x = b.x + b.width / 2,
      y = b.y + b.height / 2
    const covers = (r) =>
      r.width > 0 && r.height > 0 && x > r.left && x < r.right && y > r.top && y < r.bottom
    return {
      overlap: covers(c) && covers(w),
      content: getComputedStyle(content).pointerEvents,
      wrapper: getComputedStyle(wrapper).pointerEvents,
      hit: button.contains(document.elementFromPoint(x, y))
    }
  })
  expect(probe).toEqual({ overlap: true, content: 'none', wrapper: 'none', hit: true })
  await next.click()
  await expect(search).toContainText('2/2')
  expect(errors).toEqual([])
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => [w.isVisible(), w.isFocused()])
  )
  expect(windows).toEqual([[false, false]])
  console.log(`PASS: native header geometry and tooltip pointer passage (${output})`)
} finally {
  await app.close()
}
