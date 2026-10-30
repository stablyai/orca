/**
 * Invariant: the Try it on a plugin's install toast does the thing itself instead of opening
 * the plugin's page — a grammar opens a highlighted sample, an editor a new file of its own.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  createGleamCatalogFixture,
  EXCALIDRAW_PLUGIN_KEY,
  EXCALIDRAW_TEMPLATE,
  GLEAM_PLUGIN_KEY
} from './helpers/plugin-gleam-catalog-fixture'
import { editorTokenClasses } from './helpers/plugin-smoke'

async function openPluginPage(
  app: ElectronApplication,
  page: Page,
  pluginKey: string,
  name: string
) {
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit('open-url', { preventDefault: () => undefined }, link)
  }, `orca://plugins/${pluginKey}?catalog=official`)
  await expect(page.getByRole('article').locator('#plugin-detail-heading')).toContainText(name, {
    timeout: 30_000
  })
}

async function tryFromToast(page: Page, name: string): Promise<void> {
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: `${name} installed` })
  await toast.getByRole('button', { name: 'Try it' }).click({ timeout: 30_000 })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeHidden()
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('Try it opens a highlighted sample and a new drawing', async ({}, testInfo) => {
  // Why: one Electron launch, a Git catalog fetch and two installs; slower than the 30s default.
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-try-it-e2e-'))
  const fixture = await createGleamCatalogFixture(root)
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { app, page } = launched
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: true })
      window.__store?.setState({ settings })
      await window.api.plugins.refreshMarketplaces?.({})
    })
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            (await window.api.plugins.listMarketplacePlugins()).map((entry) => entry.pluginKey)
          ),
        { timeout: 60_000 }
      )
      .toEqual(expect.arrayContaining([GLEAM_PLUGIN_KEY, EXCALIDRAW_PLUGIN_KEY]))
    await attachRepoAndOpenTerminal(page, fixture.workspace)

    await openPluginPage(app, page, GLEAM_PLUGIN_KEY, 'Gleam')
    await page.getByRole('article').getByRole('button', { name: 'Install Gleam' }).click()
    await tryFromToast(page, 'Gleam')
    await expect(page.locator('[data-tab-id]').filter({ hasText: 'untitled.gleam' })).toBeVisible()
    // The plugin grammar paints the sample in more than one token class.
    await expect
      .poll(async () => (await editorTokenClasses(page, 'pub fn main')).length, {
        timeout: 15_000
      })
      .toBeGreaterThan(1)

    await openPluginPage(app, page, EXCALIDRAW_PLUGIN_KEY, 'Excalidraw')
    await page
      .getByRole('article')
      .getByRole('button', { name: /^Install & enable/ })
      .click({ timeout: 30_000 })
    await tryFromToast(page, 'Excalidraw')
    await expect
      .poll(() =>
        readFile(join(fixture.workspace, 'untitled.excalidraw'), 'utf8').catch(() => null)
      )
      .toBe(EXCALIDRAW_TEMPLATE)
    await expect(
      page.locator('[data-tab-id]').filter({ hasText: 'untitled.excalidraw' })
    ).toBeVisible()
    await expect(page.locator('iframe[title="Excalidraw"]')).toBeVisible({ timeout: 15_000 })
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
