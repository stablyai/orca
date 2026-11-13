/**
 * Invariant: a `placement: "page"` panel, HTML or components, gets a top-left nav entry instead of
 * a right-sidebar tab, and the entry opens the panel as the current page with its content drawn.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import {
  evalInGuest,
  pluginGuest,
  waitForGuestReady,
  ISOLATED_FRAMES_E2E
} from './helpers/plugin-frame-guest'

test.use(ISOLATED_FRAMES_E2E)

async function writePagePlugin(
  root: string,
  id: string,
  panel: { title: string; entry: string; ui?: 'components' },
  source: string
): Promise<string> {
  const pluginRoot = join(root, id)
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(
    join(pluginRoot, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id,
      name: panel.title,
      version: '1.0.0',
      engines: { orca: '>=1.4.259' },
      pluginApi: 1,
      contributes: { panels: [{ id: 'main', placement: 'page', ...panel }] }
    })
  )
  await writeFile(join(pluginRoot, panel.entry), source)
  return pluginRoot
}

test('page panels open from the left sidebar, not the right sidebar', async ({ orcaPage }) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-page-placement-'))
  try {
    const htmlRoot = await writePagePlugin(
      tempRoot,
      'html-page',
      { title: 'HTML Page', entry: 'panel.html' },
      '<!doctype html><p id="out">html page drawn</p>'
    )
    const componentsRoot = await writePagePlugin(
      tempRoot,
      'components-page',
      { title: 'Components Page', entry: 'panel.tsx', ui: 'components' },
      "import { Heading } from 'orca'\nexport default function Panel() {\n  return <Heading>Components page drawn</Heading>\n}\n"
    )
    await enableDevPlugins(orcaPage, [htmlRoot, componentsRoot])
    await orcaPage.evaluate(async () => {
      const store = window.__store?.getState()
      if (store && !store.rightSidebarOpen) {
        store.toggleRightSidebar()
      }
      await window.api.plugins.refresh()
    })

    const htmlEntry = orcaPage.getByRole('button', { name: 'HTML Page', exact: true })
    const componentsEntry = orcaPage.getByRole('button', { name: 'Components Page', exact: true })
    // One button each: the left-sidebar entry, and no right-sidebar tab.
    await expect(htmlEntry).toHaveCount(1, { timeout: 15_000 })
    await expect(componentsEntry).toHaveCount(1)

    await htmlEntry.click()
    await expect(htmlEntry).toHaveAttribute('aria-current', 'page')
    const guest = pluginGuest(orcaPage, 'HTML Page')
    await expect(guest).toBeVisible({ timeout: 15_000 })
    await waitForGuestReady(guest)
    await expect
      .poll(
        () =>
          evalInGuest<string | null>(
            guest,
            'document.getElementById("out")?.textContent ?? null'
          ).catch(() => null),
        { timeout: 15_000 }
      )
      .toBe('html page drawn')

    await componentsEntry.click()
    await expect(componentsEntry).toHaveAttribute('aria-current', 'page')
    await expect(htmlEntry).not.toHaveAttribute('aria-current', 'page')
    await expect(orcaPage.getByRole('heading', { name: 'Components page drawn' })).toBeVisible({
      timeout: 15_000
    })
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
