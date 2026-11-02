/**
 * Invariant: an `orca://plugins/...` link opens the plugin's page in Settings, waiting while
 * plugins are off until they are turned back on, and never installs. A malformed link only toasts, and an unknown
 * catalog asks first. The link is delivered through main's open-url handler; no protocol is
 * registered on the machine running the test.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createGleamCatalogFixture, GLEAM_PLUGIN_KEY } from './helpers/plugin-gleam-catalog-fixture'

async function openLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit('open-url', { preventDefault: () => undefined }, link)
  }, url)
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('an install link opens the plugin page and never installs', async ({}, testInfo) => {
  // Why: one Electron launch plus a Git catalog fetch and a plugin page; slower than the 30s default on CI.
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-install-link-e2e-'))
  const fixture = await createGleamCatalogFixture(root)
  const session = createRestartSession(testInfo as TestInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { app, page } = launched
    // Fetch the catalog once, then turn plugins off so the link has to wait behind the switch.
    await page.evaluate(async () => {
      await window.api.settings.set({ pluginSystemEnabled: true })
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
      .toContain(GLEAM_PLUGIN_KEY)
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: false })
      window.__store?.setState({ settings })
    })

    await openLink(app, 'orca://plugins/stablyai..bad')
    await expect(page.getByText('That plugin link isn’t valid.')).toBeVisible({ timeout: 15_000 })

    await openLink(app, `orca://plugins/${GLEAM_PLUGIN_KEY}?catalog=official`)
    await expect(page.getByText('Plugins are off')).toBeVisible({ timeout: 15_000 })
    // Off comes only from a saved choice now; turning it back on lands on the waiting link's page.
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: true })
      window.__store?.setState({ settings })
    })
    const pluginPage = page.getByRole('article')
    await expect(pluginPage.locator('#plugin-detail-heading')).toContainText('Gleam', {
      timeout: 30_000
    })
    await expect(pluginPage.getByRole('button', { name: /^Install/ })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const catalogUrl = encodeURIComponent('https://github.com/acme/orca-catalog.git')
    await openLink(app, `orca://plugins/acme.dusk?catalog=${catalogUrl}`)
    const prompt = page.getByRole('dialog', { name: 'Add catalog github.com/acme?' })
    await expect(prompt).toBeVisible({ timeout: 15_000 })
    await prompt.getByRole('button', { name: 'Cancel' }).click()
    await expect(prompt).toBeHidden()

    const state = await page.evaluate(async () => ({
      installed: (await window.api.plugins.list()).map((entry) => entry.pluginKey),
      catalogs: (await window.api.plugins.listMarketplaces()).map((entry) => entry.source.url)
    }))
    expect(state.installed).not.toContain(GLEAM_PLUGIN_KEY)
    expect(state.catalogs).not.toContain('https://github.com/acme/orca-catalog.git')
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
