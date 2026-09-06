import type { Page } from '@stablyai/playwright-test'
import type { PairedElectronClient, RuntimeDesktopPairingOffer } from './paired-electron-client'
import { revealPairedClientWindow } from './paired-client-window-reveal'

/**
 * Points a freshly launched paired desktop client at the HUB runtime and makes it the active
 * environment, returning the environment id.
 *
 * On a reused profile the stored environment is adopted as-is: re-pairing there would mint a second
 * credential and a second device identity, which is exactly what a relaunch must NOT do.
 */
export async function selectPairedRuntimeEnvironment(
  page: Page,
  args: { name: string; pairingUrl: string; reusedProfile: boolean }
): Promise<string> {
  return page.evaluate(async ({ name, pairingUrl, reusedProfile }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired desktop store is unavailable')
    }
    const existing = reusedProfile ? await window.api.runtimeEnvironments.list() : []
    const environmentId =
      existing[0]?.id ??
      (
        await window.api.runtimeEnvironments.addFromPairingCode({
          name,
          pairingCode: pairingUrl
        })
      ).environment.id
    store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
    if (!(await store.getState().refreshRuntimeEnvironmentStatus(environmentId))) {
      throw new Error('Paired desktop could not reach the HUB runtime')
    }
    if (!(await store.getState().setActiveRuntimeEnvironmentPreference(environmentId))) {
      throw new Error('Paired desktop could not select the HUB runtime')
    }
    return environmentId
  }, args)
}

export async function rePairPairedElectronClient(
  client: PairedElectronClient,
  offer: RuntimeDesktopPairingOffer,
  name: string
): Promise<void> {
  await client.captureDirectSshAttempts()
  const environmentId = await client.page.evaluate(
    async ({ currentEnvironmentId, name, pairingUrl }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      if (!(await store.getState().setActiveRuntimeEnvironmentPreference(null))) {
        throw new Error('Paired desktop could not select local before replacing the HUB')
      }
      await window.api.runtimeEnvironments.remove({ selector: currentEnvironmentId })
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name,
        pairingCode: pairingUrl
      })
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(result.environment.id))) {
        throw new Error('Re-paired desktop could not reach the HUB runtime')
      }
      if (!(await store.getState().setActiveRuntimeEnvironmentPreference(result.environment.id))) {
        throw new Error('Re-paired desktop could not select the HUB runtime')
      }
      return result.environment.id
    },
    {
      currentEnvironmentId: client.environmentId,
      name,
      pairingUrl: offer.pairingUrl
    }
  )
  client.environmentId = environmentId
  // Why: removing and re-adding the same HUB changes the environment identity; remount so no pane keeps the retired transport wrapper.
  await client.page.reload()
  // Xvfb needs a mapped window to resume actionability frames after reload.
  if (
    process.env.GITHUB_ACTIONS === 'true' &&
    process.platform === 'linux' &&
    process.env.DISPLAY &&
    process.env.ORCA_BACKGROUND_LAUNCH !== '1'
  ) {
    await revealPairedClientWindow(client)
  }
  await client.page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 30_000, polling: 100 }
  )
  await client.installDirectSshAttemptProbe()
  const reachable = await client.page.evaluate(async (nextEnvironmentId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Re-paired desktop store is unavailable after reload')
    }
    if (!(await store.getState().refreshRuntimeEnvironmentStatus(nextEnvironmentId))) {
      return false
    }
    return store.getState().setActiveRuntimeEnvironmentPreference(nextEnvironmentId)
  }, environmentId)
  if (!reachable) {
    throw new Error('Re-paired desktop could not reach the HUB after reload')
  }
}
