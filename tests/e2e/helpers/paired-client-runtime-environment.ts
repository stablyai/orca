import type { Page } from '@stablyai/playwright-test'

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
