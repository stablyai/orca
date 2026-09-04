/**
 * E2E proof: an auto-discovered custom browser ("From Aside") shows up in Orca's
 * per-profile cookie-import dropdown.
 *
 * Detection (macOS): the renderer's `fetchDetectedBrowsers()` calls the
 * `browser:session:detectBrowsers` IPC handler, which runs `detectAllBrowsers()`.
 * That queries LaunchServices for installed https handlers and resolves each to a
 * custom Chromium browser only when its data dir under
 * `<HOME>/Library/Application Support/<DisplayName>` owns a Chromium cookie store
 * (a `Local State` file + a resolvable `Default` cookies DB).
 *
 * Determinism: the OS query is replaced by the `ORCA_E2E_FAKE_HTTPS_HANDLERS` env
 * seam (see detectAllBrowsers), and a fake data dir is seeded under the isolated
 * HOME, so "From Aside" renders on any macOS machine/CI without Aside installed.
 * macOS-only (auto-discovery is mac-first), so the test skips elsewhere.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Display name the synthetic LaunchServices candidate reports for Aside.
const ASIDE_DISPLAY_NAME = 'Aside'

// Synthetic https-handler candidate injected via the env seam so detection does
// not depend on Aside being installed on the host.
const FAKE_HTTPS_HANDLERS = JSON.stringify([
  {
    bundleId: 'at.studio.AsideBrowser',
    displayName: ASIDE_DISPLAY_NAME,
    appPath: '/Applications/Aside.app'
  }
])

test.describe('Cookie import custom browser auto-discovery', () => {
  test.skip(process.platform !== 'darwin', 'custom-browser auto-discovery is macOS-only')
  test.use({ orcaAppExtraEnv: { ORCA_E2E_FAKE_HTTPS_HANDLERS: FAKE_HTTPS_HANDLERS } })

  test('auto-discovered browser appears in the cookie import picker', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)

    // Seed a minimal fake Aside Chromium data dir inside the app's isolated HOME so
    // `detectAllBrowsers()` resolves the injected LaunchServices candidate to a
    // custom browser. The launched app's resolved home equals the isolated HOME;
    // the test process shares the filesystem, so writing here is visible.
    const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const dataDir = path.join(isolatedHome, 'Library', 'Application Support', ASIDE_DISPLAY_NAME)
    const defaultDir = path.join(dataDir, 'Default')
    mkdirSync(defaultDir, { recursive: true })
    // A Local State file marks it as a Chromium profile root.
    writeFileSync(path.join(dataDir, 'Local State'), '{}')
    // A Default/Cookies DB satisfies resolveChromiumCookiesPath (legacy path).
    writeFileSync(path.join(defaultDir, 'Cookies'), '')

    // Force English, re-run detection now that the fake Aside dir exists (startup
    // cached []), and deep-link straight to the Browser pane's Session & Cookies
    // section via the store.
    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.setState({ detectedBrowsers: [], detectedBrowsersLoaded: false })
      await store.getState().fetchDetectedBrowsers()
      store.getState().openSettingsTarget({
        pane: 'browser',
        repoId: null,
        sectionId: 'browser-session-cookies'
      })
      store.getState().openSettingsPage()
    })

    // The Radix "Import Cookies" trigger anchors the Session & Cookies section
    // (SearchableSetting renders its title only for search, so the button — not a
    // heading — is the reliable anchor).
    const importTrigger = orcaPage
      .locator('[data-slot="dropdown-menu-trigger"]')
      .filter({ hasText: 'Import Cookies' })
      .first()
    await expect(importTrigger).toBeVisible({ timeout: 10_000 })
    await orcaPage.bringToFront()
    await importTrigger.focus()

    // Open the per-profile "Import Cookies" dropdown (Default profile row). Retry:
    // the menu can miss the first click before the section paints.
    const menuItems = orcaPage.locator('[data-slot="dropdown-menu-item"]')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await importTrigger.click()
      try {
        await expect.poll(() => menuItems.count(), { timeout: 2_500 }).toBeGreaterThan(0)
        break
      } catch {
        // Retry.
      }
    }

    // Deterministic now that the OS query is faked and the data dir is seeded.
    await expect(orcaPage.getByRole('menuitem', { name: 'From Aside', exact: true })).toBeVisible()

    const screenshotPath = testInfo.outputPath('from-aside-proof.png')
    await orcaPage.screenshot({ path: screenshotPath })
    process.stdout.write(`[from-aside] screenshot written to: ${screenshotPath}\n`)
  })
})
