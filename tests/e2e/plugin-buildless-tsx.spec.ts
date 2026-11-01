/**
 * Invariant: a plugin ships TSX with no build step. The frame protocol transpiles `.tsx`/`.ts` on
 * load and resolves extensionless relative imports, for a components panel and an HTML frame
 * whose entry is a `.ts` module; a bare package import fails with an error naming file:line:col.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import {
  evalInGuest,
  pluginGuest,
  waitForGuestReady,
  ISOLATED_FRAMES_E2E
} from './helpers/plugin-frame-guest'

test.use(ISOLATED_FRAMES_E2E)

async function openPanel(page: Page, title: string): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store?.getState()
    if (store && !store.rightSidebarOpen) {
      store.toggleRightSidebar()
    }
    await window.api.plugins.refresh()
  })
  const button = page.getByRole('button', { name: title })
  await expect(button).toBeVisible({ timeout: 15_000 })
  await button.click()
}

test('the build-less TSX example renders and updates with no dist folder', async ({ orcaPage }) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-buildless-tsx-'))
  const pluginRoot = join(tempRoot, 'hello-tsx')
  try {
    await cp(join(process.cwd(), 'examples', 'plugins', 'hello-tsx'), pluginRoot, {
      recursive: true
    })
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openPanel(orcaPage, 'Hello TSX')

    await expect(orcaPage.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 15_000 })
    // From ./todos, imported without an extension and resolved to todos.ts.
    await expect(orcaPage.getByText('Edit src/panel.tsx and save')).toBeVisible()
    await expect(orcaPage.getByText('1 open')).toBeVisible()
    await orcaPage.getByPlaceholder('New task').fill('Ship without a build')
    await orcaPage.getByRole('button', { name: 'Add task' }).click()
    await expect(orcaPage.getByText('Ship without a build')).toBeVisible()
    await expect(orcaPage.getByText('2 open')).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('an HTML frame panel can name a .ts entry, and bare imports fail by name', async ({
  orcaPage
}) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-buildless-frame-'))
  const pluginRoot = join(tempRoot, 'ts-frame')
  try {
    await mkdir(join(pluginRoot, 'app'), { recursive: true })
    await writeFile(
      join(pluginRoot, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'sandboxed-ui',
        id: 'ts-frame',
        name: 'TS Frame',
        version: '1.0.0',
        engines: { orca: '>=1.4.246' },
        pluginApi: 1,
        contributes: { panels: [{ id: 'page', title: 'TS Frame', entry: 'app/page.ts' }] }
      })
    )
    await writeFile(
      join(pluginRoot, 'app', 'page.ts'),
      [
        "import { greeting } from './greeting'",
        'const out: HTMLElement = document.createElement("p")',
        'out.id = "out"',
        'out.textContent = greeting(2)',
        'document.body.append(out)',
        "import('./bare').catch((error: Error) => { out.dataset.bare = error.message })"
      ].join('\n')
    )
    await writeFile(
      join(pluginRoot, 'app', 'greeting.ts'),
      'export const greeting = (n: number): string => `typed ${n * 21}`\n'
    )
    await writeFile(join(pluginRoot, 'app', 'bare.ts'), "import 'left-pad'\nexport {}\n")
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openPanel(orcaPage, 'TS Frame')

    const guest = pluginGuest(orcaPage, 'TS Frame')
    await expect(guest).toBeVisible({ timeout: 15_000 })
    await waitForGuestReady(guest)
    // Why tolerant: the guest can remount while the panel settles; the poll then retries.
    const read = (expression: string) =>
      evalInGuest<string | null>(guest, `${expression} ?? null`).catch(() => null)
    await expect
      .poll(() => read('document.getElementById("out")?.textContent'), { timeout: 15_000 })
      .toBe('typed 42')
    await expect
      .poll(() => read('document.getElementById("out")?.dataset.bare'), { timeout: 15_000 })
      .toContain('app/bare.ts:1:8: cannot import "left-pad"')
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
