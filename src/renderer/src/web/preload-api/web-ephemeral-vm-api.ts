import type { EphemeralVmApi, EphemeralVmOwner } from '../../../../shared/ephemeral-vm-api'
import { callEnvironmentEnvelope, callRuntimeResult } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

export function createWebEphemeralVmApi(): EphemeralVmApi {
  async function call<T>(method: string, args?: EphemeralVmOwner, timeoutMs = 60_000): Promise<T> {
    const { ownerEnvironmentId, ...params } = args ?? {}
    const payload = method === 'listRuntimes' || method === 'listRecipeCatalog' ? undefined : params
    if (!ownerEnvironmentId) {
      return callRuntimeResult(
        `ephemeralVm.${method === 'provision' && 'workspaceRequest' in params ? 'provisionWorkspace' : method}`,
        payload,
        timeoutMs
      )
    }
    const response = await callEnvironmentEnvelope<T>(
      ownerEnvironmentId,
      `ephemeralVm.${method === 'provision' && 'workspaceRequest' in params ? 'provisionWorkspace' : method}`,
      payload,
      timeoutMs
    )
    if (!response.ok) {
      throw new Error(`Server-owned VM recipes: ${response.error.message}`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generic RPC envelope was requested as T above.
    return response.result as T
  }
  return {
    listRecipes: (args) => call('listRecipes', args),
    listRecipeCatalog: (args) => call('listRecipeCatalog', args),
    doctor: (args) => call('doctor', args),
    provision: (args) => call('provision', args, 30 * 60_000),
    adoptProvisionedRoot: (args) => call('adoptProvisionedRoot', args),
    cancelProvision: (args) => call('cancelProvision', args),
    onProvisionEvent: () => noopUnsubscribe,
    listRuntimes: (args) => call('listRuntimes', args),
    attachWorkspace: (args) => call('attachWorkspace', args),
    suspendWorkspace: (args) => call('suspendWorkspace', args),
    resumeWorkspace: (args) => call('resumeWorkspace', args),
    cleanup: (args) => call('cleanup', args),
    stopCleanup: (args) => call('stopCleanup', args),
    getCleanupCommand: (args) => call('getCleanupCommand', args)
  }
}
