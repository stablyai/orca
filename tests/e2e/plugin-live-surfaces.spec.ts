/**
 * Invariant: a dev-path plugin's worker drives a status-bar item (render,
 * live update, click runs its command) and pushes live messages into its
 * sandboxed panel, which can message the worker back — all only after the
 * user consents to the statusBar and panelMessaging capabilities.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

const PLUGIN_KEY = 'orca-samples.live-status'
const PULSE = `[data-plugin-status-item="${PLUGIN_KEY}/pulse"]`
const OPEN_PANEL = `[data-plugin-status-item="${PLUGIN_KEY}/open-panel"]`

async function readPulse(page: Page): Promise<number> {
  const text = (await page.locator(PULSE).textContent()) ?? ''
  const match = /Pulse (\d+)/.exec(text)
  if (!match) {
    throw new Error(`unexpected status bar text: ${text}`)
  }
  return Number(match[1])
}

async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { statusBarOnly?: boolean } = {}
): Promise<void> {
  // CDP capture of the hidden test window; never brings it to the foreground.
  const path = testInfo.outputPath(`${name}.png`)
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  await page.screenshot({
    path,
    ...(options.statusBarOnly
      ? { clip: { x: 0, y: viewport.height - 28, width: viewport.width, height: 28 } }
      : {})
  })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('drives a plugin status-bar item and live panel from the plugin worker', async ({
  orcaPage
}, testInfo) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-live-status-plugin-e2e-'))
  const pluginRoot = join(tempRoot, 'live-status')
  await cp(join(process.cwd(), 'examples', 'plugins', 'live-status'), pluginRoot, {
    recursive: true
  })

  try {
    const pending = await orcaPage.evaluate(async (sourcePath) => {
      const settings = await window.api.settings.set({
        pluginSystemEnabled: true,
        devPluginPaths: [sourcePath]
      })
      window.__store?.setState({ settings })
      const plugins = await window.api.plugins.refresh()
      return plugins.find((entry) => entry.pluginKey === 'orca-samples.live-status') ?? null
    }, pluginRoot)
    expect(pending).toMatchObject({ status: 'pending', isDev: true })
    // Nothing runs before consent, so nothing reaches the status bar.
    await expect(orcaPage.locator(PULSE)).toHaveCount(0)
    await screenshot(orcaPage, testInfo, 'status-bar-before-consent', { statusBarOnly: true })

    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      state.openSettingsTarget({ pane: 'plugins', repoId: null })
      state.openSettingsPage()
    })
    await orcaPage.getByRole('tab', { name: /^Installed/ }).click()
    const row = orcaPage.locator(`[data-plugin-key="${PLUGIN_KEY}"]`)
    await row.getByRole('button', { name: 'Review & enable' }).click()
    const consent = orcaPage.getByRole('dialog', { name: 'Review permissions' })
    await expect(consent).toContainText(
      'Show short text items in the status bar, labeled with the plugin name'
    )
    await expect(consent).toContainText(
      "Exchange live messages between the plugin's worker and its own panels"
    )
    await screenshot(orcaPage, testInfo, 'consent-new-capabilities')
    await consent.getByRole('button', { name: 'Enable plugin' }).click()
    await expect(consent).toBeHidden()
    await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())

    // Consent re-lists the status bar, which starts the worker that fills it.
    const pulse = orcaPage.locator(PULSE)
    await expect(pulse).toHaveText(/Pulse \d+/, { timeout: 20_000 })
    await expect(pulse).toHaveAttribute('aria-label', /from the Live Status plugin$/)
    const first = await readPulse(orcaPage)
    await expect.poll(() => readPulse(orcaPage), { timeout: 10_000 }).toBeGreaterThan(first)
    await screenshot(orcaPage, testInfo, 'status-bar-items', { statusBarOnly: true })

    // Clicking the item runs the plugin's contributed command (a reset).
    await pulse.click()
    await expect(pulse).toHaveAttribute('aria-label', /\(1 resets so far\)/, { timeout: 10_000 })

    // The left-aligned item opens the plugin panel, which gets live worker pushes.
    await orcaPage.locator(OPEN_PANEL).click()
    const frame = orcaPage.frameLocator('iframe[title="Live Status"]')
    await expect(frame.getByRole('heading', { name: 'Live Status' })).toBeVisible({
      timeout: 15_000
    })
    // The panel's first message (sent on load) must round-trip without retries.
    await expect(frame.locator('#snapshot')).toHaveText('received', { timeout: 5_000 })
    await expect(frame.locator('#resets')).toHaveText('1', { timeout: 10_000 })
    const readReceived = async (): Promise<number> =>
      Number((await frame.locator('#received').textContent()) ?? '0')
    const receivedBefore = await readReceived()
    await expect.poll(readReceived, { timeout: 10_000 }).toBeGreaterThan(receivedBefore)

    // Panel → worker → panel and status bar: the worker sees the panel's reset.
    await frame.getByRole('button', { name: 'Reset from the panel' }).click()
    await expect(frame.locator('#resets')).toHaveText('2', { timeout: 10_000 })
    await expect(pulse).toHaveAttribute('aria-label', /\(2 resets so far\)/, { timeout: 10_000 })
    await screenshot(orcaPage, testInfo, 'live-panel')

    // Disabling the plugin removes its items with the worker.
    await orcaPage.evaluate(
      (pluginKey) => window.api.plugins.setEnabled({ pluginKey, enabled: false }),
      PLUGIN_KEY
    )
    await expect(pulse).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
