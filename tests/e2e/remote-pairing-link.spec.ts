/**
 * Invariant: an `orca://pair?...` link opens Add remote server with the link prefilled and never
 * pairs on its own. The link arrives through main's open-url handler; no protocol is registered.
 */

import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'

const OFFER = {
  v: 2,
  endpoint: 'ws://100.64.0.10:6768',
  deviceToken: 'e2e-device-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  scope: 'runtime'
}
const LINK = `orca://pair?code=${Buffer.from(JSON.stringify(OFFER)).toString('base64url')}`

async function openLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit('open-url', { preventDefault: () => undefined }, link)
  }, url)
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('a pairing link opens Add remote server prefilled and never pairs', async ({}, testInfo) => {
  // Why: one Electron launch plus renderer boot; slower than the 30s default on CI.
  test.setTimeout(120_000)
  const session = createRestartSession(testInfo)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { app, page } = launched

    await openLink(app, LINK)
    const dialog = page.getByRole('dialog', { name: 'Add remote server' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.locator('#add-server-pairing-code')).toHaveValue(LINK)
    await expect(dialog.getByText('100.64.0.10:6768')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect(await page.evaluate(() => window.api.runtimeEnvironments.list())).toEqual([])
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
  }
})
