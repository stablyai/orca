import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

test('switches the active server from the status bar between two paired hosts and local', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  const workOffer = await createRuntimeDesktopPairingOffer(orcaPage)
  let privateHost: PairedElectronClient | null = null
  let client: PairedElectronClient | null = null

  try {
    privateHost = await launchPairedElectronClient(workOffer, testInfo, 'work')
    await privateHost.page.evaluate(async () => {
      if (!(await window.__store?.getState().setActiveRuntimeEnvironmentPreference(null))) {
        throw new Error('Could not prepare the second runtime host')
      }
    })
    const privateOffer = await createRuntimeDesktopPairingOffer(privateHost.page)
    client = await launchPairedElectronClient(workOffer, testInfo, 'work')
    const page = client.page
    // Hidden windows do not advance CSS animations; keep Radix's close transition deterministic.
    await page.addStyleTag({
      content: '* { animation: none !important; transition: none !important; }'
    })
    await page.evaluate(async (pairingUrl) => {
      await window.api.runtimeEnvironments.addFromPairingCode({
        name: 'priv',
        pairingCode: pairingUrl
      })
      window.__store?.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
    }, privateOffer.pairingUrl)

    const workTrigger = page.getByRole('button', { name: 'Active Server: work', exact: true })
    await expect(workTrigger).toBeVisible()
    await expect(workTrigger).toContainText('work')
    await workTrigger.click({ force: true })
    await expect(page.getByRole('menuitemradio', { name: 'work', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page.keyboard.press('Escape')
    await expect(workTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('menu')).toBeHidden()

    await workTrigger.press('ArrowDown')
    await page.getByRole('menuitemradio', { name: 'priv', exact: true }).focus()
    await page.keyboard.press('Enter')
    const privateTrigger = page.getByRole('button', { name: 'Active Server: priv', exact: true })
    await expect(privateTrigger).toBeVisible()
    await expect(privateTrigger).toBeEnabled()

    await privateTrigger.click({ force: true })
    await expect(page.getByRole('menuitemradio', { name: 'priv', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page
      .getByRole('menuitemradio', { name: 'Local desktop', exact: true })
      .click({ force: true })
    const localTrigger = page.getByRole('button', {
      name: 'Active Server: Local desktop',
      exact: true
    })
    await expect(localTrigger).toBeVisible()
    await expect(localTrigger).toBeEnabled()
    await localTrigger.click({ force: true })
    await page.getByRole('menuitemradio', { name: 'work', exact: true }).click({ force: true })
    await expect(workTrigger).toBeVisible()
    await expect(workTrigger).toBeEnabled()
  } finally {
    await client?.dispose()
    await privateHost?.dispose()
  }
})
