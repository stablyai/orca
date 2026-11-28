import type { ElectronApplication, Page } from '@stablyai/playwright-test'

/** Whether this run starts the app and its servers on the main-owned layout path (the switch-on lane sets both). */
export const LAYOUT_OWNER_SWITCH_ON = process.env.ORCA_LAYOUT_OWNER === 'main'

type LaunchEnv = Record<string, string | undefined>

const expectedOwner = (setting: string | undefined): 'main' | 'window' =>
  setting === 'main' ? 'main' : 'window'

/** A setting the app did not take would turn every switch-on spec into a silent switch-off run. */
export async function expectAppTookLayoutOwner(
  app: ElectronApplication,
  launchEnv: LaunchEnv,
  page?: Page
): Promise<void> {
  const expected = expectedOwner(launchEnv.ORCA_LAYOUT_OWNER)
  const host = await app.evaluate(() => process.env.ORCA_LAYOUT_OWNER_RESOLVED)
  const renderer = page ? await page.evaluate(() => window.__orcaLayoutOwner ?? null) : expected
  if (host !== expected || renderer !== expected) {
    throw new Error(
      `Layout owner did not take effect: expected ${expected}, main ${String(host)}, renderer ${String(renderer)}`
    )
  }
}

/** Servers read their own setting, never the desktop's. */
export async function expectServerTookLayoutOwner(
  app: ElectronApplication,
  launchEnv: LaunchEnv
): Promise<void> {
  const expected = expectedOwner(launchEnv.ORCA_SERVER_LAYOUT_OWNER)
  const host = await app.evaluate(() => process.env.ORCA_LAYOUT_OWNER_RESOLVED)
  if (host !== expected) {
    throw new Error(
      `Server layout owner did not take effect: expected ${expected}, got ${String(host)}`
    )
  }
}

/** For a server with no Electron handle (orcad, `orca serve`): its advertised capability shows the path it took. */
export async function expectRuntimeTookLayoutOwner(
  client: { call<T>(method: string): Promise<{ result: T }> },
  launchEnv: LaunchEnv
): Promise<void> {
  const expected = expectedOwner(launchEnv.ORCA_SERVER_LAYOUT_OWNER)
  const status = await client.call<{ capabilities?: string[] }>('status.get')
  const capabilities = status.result.capabilities ?? []
  const host = capabilities.includes('layout.intents.v1') ? 'main' : 'window'
  if (capabilities.length === 0 || host !== expected) {
    throw new Error(
      `Server layout owner did not take effect: expected ${expected}, capabilities say ${host}`
    )
  }
}

/** The browser client copies the host that serves it, through the meta tag the host adds. */
export async function expectWebClientTookLayoutOwner(
  hostApp: ElectronApplication,
  page: Page
): Promise<void> {
  const host = await hostApp.evaluate(() => process.env.ORCA_LAYOUT_OWNER_RESOLVED)
  await page.waitForLoadState('domcontentloaded')
  const client = await page.evaluate(
    () =>
      document.querySelector('meta[name="orca-layout-owner"]')?.getAttribute('content') ?? 'window'
  )
  if (client !== host) {
    throw new Error(`Web client layout owner ${client} differs from its host's ${String(host)}`)
  }
}
