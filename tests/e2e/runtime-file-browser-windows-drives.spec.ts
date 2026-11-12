import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForSessionReady } from './helpers/store'

test.describe('paired runtime Windows file browser', () => {
  test.skip(process.platform !== 'win32', 'Windows drive roots require a Windows runtime host')

  test('reports the runtime path flavor with Windows drive roots', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const client = await launchPairedElectronClient(offer, testInfo, 'Windows drive browser')

    try {
      const driveRoot = path.parse(os.tmpdir()).root.toUpperCase()
      const listing = await client.page.evaluate(async () => {
        const [environment] = await window.api.runtimeEnvironments.list()
        if (!environment) {
          throw new Error('Paired client runtime environment is unavailable')
        }
        const response = await window.api.runtimeEnvironments.call({
          selector: environment.id,
          method: 'files.browseServerDir',
          params: { path: '/' },
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result as {
          pathFlavor: string
          entries: { name: string; isDirectory: boolean }[]
        }
      })

      expect(listing.pathFlavor).toBe('win32')
      expect(listing.entries).toContainEqual({
        name: driveRoot,
        isDirectory: true,
        isSymlink: false
      })
    } finally {
      await client.dispose()
    }
  })
})
