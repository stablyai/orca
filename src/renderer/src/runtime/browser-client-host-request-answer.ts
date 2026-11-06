import { getOrcadSshDeployment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

// Managed SSH hosts reach this desktop's own browser through the desktop browser bridge instead.
function hostsBrowserPagesOn(
  environment: Parameters<typeof getOrcadSshDeployment>[0] | undefined
): boolean {
  return Boolean(environment && !getOrcadSshDeployment(environment))
}

/** Whether this desktop offers to host the browser pages of the server it subscribes to. */
export function hostsBrowserPagesFor(environmentId: string): boolean {
  const environments = useAppStore.getState().runtimeEnvironments
  return hostsBrowserPagesOn(environments?.find((entry) => entry.id === environmentId))
}

/** Start hosting a server's browser pages when it asks and this desktop would host new pages there anyway (#35066). */
export async function answerBrowserClientHostRequest(
  environmentId: string,
  requestId: string
): Promise<void> {
  const expectedPairingRevision = getRuntimeEnvironmentRevision(environmentId)
  const browserHostClientId = await prepareRequestedHost(environmentId, expectedPairingRevision)
  try {
    await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'browser.clientHost.requestResult',
      params: { requestId, ...(browserHostClientId ? { browserHostClientId } : {}) },
      expectedEnvironmentPairingRevision: expectedPairingRevision,
      timeoutMs: 15_000
    })
  } catch (error) {
    // The server stops waiting on its own deadline.
    console.warn('[browser-client-host-request] failed to answer', environmentId, error)
  }
}

async function prepareRequestedHost(
  environmentId: string,
  expectedPairingRevision: number | undefined
): Promise<string | undefined> {
  try {
    const environment = (await window.api.runtimeEnvironments.list()).find(
      (entry) => entry.id === environmentId
    )
    if (!hostsBrowserPagesOn(environment)) {
      return undefined
    }
    // Answers server placement when the user renders this server's pages there or it cannot host them.
    const placement = await window.api.runtimeEnvironments.prepareBrowserClientHostPlacement({
      selector: environmentId,
      ...(expectedPairingRevision !== undefined ? { expectedPairingRevision } : {}),
      preference: 'auto'
    })
    return placement.kind === 'client' ? placement.browserHostClientId : undefined
  } catch (error) {
    console.warn('[browser-client-host-request] failed to start hosting', environmentId, error)
    return undefined
  }
}
