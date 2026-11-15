import type * as core from './runtime-environment-resume-pairing-operations'
import { submitEnvironmentStoreCommand } from './runtime-environment-store-worker-client'
import { replaceEnvironmentPairing } from './runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../host-catalog/runtime-environments'

export type ResumePairingRefreshOutcome = {
  environment: KnownRuntimeEnvironment
  reusedPairing: boolean
  endpointChanged: boolean
  repairFromFreshOffer: () => Promise<KnownRuntimeEnvironment>
}
export async function refreshEnvironmentFromResumePairingCode(
  ...args: Parameters<typeof core.refreshEnvironmentFromResumePairingCode>
): Promise<ResumePairingRefreshOutcome> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'refreshEnvironmentFromResumePairingCode',
    args
  })
  if (reply.operation !== 'refreshEnvironmentFromResumePairingCode') {
    throw new Error('Unexpected environment store response')
  }
  const { repair, ...outcome } = reply.value
  return {
    ...outcome,
    repairFromFreshOffer: () =>
      repair
        ? replaceEnvironmentPairing(args[0], outcome.environment.id, repair.offer, {
            now: repair.now,
            connectionDependency: repair.connectionDependency
          })
        : Promise.resolve(outcome.environment)
  }
}
