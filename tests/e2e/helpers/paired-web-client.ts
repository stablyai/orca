import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { createPairedWebClientUrl, type PairedWebClientOptions } from './paired-web-client-url'

export type RuntimeDesktopPairingOffer = {
  pairingUrl: string
  webClientUrl?: string
}

export type PairedWebClient = {
  page: Page
  dispose: () => Promise<void>
}

export async function launchPairedWebClient(
  hubApp: ElectronApplication,
  offer: RuntimeDesktopPairingOffer,
  options: PairedWebClientOptions = {}
): Promise<PairedWebClient> {
  if (!offer.webClientUrl) {
    throw new Error('HUB runtime did not provide a paired web client URL')
  }
  const clientUrl = createPairedWebClientUrl(offer.webClientUrl, options)
  let page: Page | undefined
  const pagePromise = hubApp.waitForEvent('window').then((candidate) => (page = candidate))
  try {
    await hubApp.evaluate(
      async ({ BrowserWindow }, { partition, show, url, userAgent }) => {
        const clientWindow = new BrowserWindow({
          height: 1200,
          show,
          width: 1440,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            partition,
            sandbox: true
          }
        })
        if (userAgent) {
          clientWindow.webContents.setUserAgent(userAgent)
        }
        await clientWindow.loadURL(url).catch((error) => {
          clientWindow.destroy()
          throw error
        })
      },
      {
        partition: `e2e-nested-runtime-web-${randomUUID()}`,
        show: options.show ?? false,
        userAgent: options.userAgent ?? null,
        url: clientUrl
      }
    )
    page = await pagePromise
    if (options.waitForWorkspace !== false) {
      await page.locator('[data-worktree-sidebar]').waitFor({ state: 'visible', timeout: 30_000 })
    }
    return { page, dispose: () => page?.close() ?? Promise.resolve() }
  } catch (error) {
    void pagePromise.catch(() => undefined)
    await page?.close().catch(() => undefined)
    throw error
  }
}
