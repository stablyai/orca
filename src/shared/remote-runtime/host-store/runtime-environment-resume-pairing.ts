import type { KnownRuntimeEnvironment } from '../host-catalog/runtime-environments'
import { sameHostKeyB64 } from '../host-catalog/runtime-environment-host-key-match'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import { assertNoIndependentSshAccess } from './runtime-environment-pairing-replace-guards'
import {
  getPairingConnectionDependency,
  parseRemotePairingCode,
  replaceEnvironmentPairing,
  resolveEnvironmentFromStore
} from './runtime-environment-store'

export type ResumePairingRefreshOutcome = {
  environment: KnownRuntimeEnvironment
  /** The saved device token was kept because the resumed server kept its host key. */
  reusedPairing: boolean
  endpointChanged: boolean
}

/**
 * Applies a resumed VM's pairing code. Why: the code's token is a fresh pending offer; adopting
 * it on every resume uses it up, so the server mints another device row on its next boot. Same
 * host key means the same server state, so the saved token still authenticates.
 */
export function refreshEnvironmentFromResumePairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number }
): ResumePairingRefreshOutcome {
  const offer = parseRemotePairingCode(userDataPath, args.pairingCode)
  const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
  assertNoIndependentSshAccess(current)
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, current.id)
  const preferred =
    persisted.endpoints.find((entry) => entry.id === persisted.preferredEndpointId) ??
    persisted.endpoints[0]
  const now = args.now ?? Date.now()
  if (!preferred || !sameHostKeyB64(preferred.publicKeyB64, offer.publicKeyB64)) {
    // A new identity (rebuilt VM, cleared state) can only be authenticated by its fresh pairing.
    const environment = replaceEnvironmentPairing(userDataPath, current.id, offer, {
      now,
      connectionDependency: current.connectionDependency
    })
    return { environment, reusedPairing: false, endpointChanged: true }
  }
  if (preferred.endpoint === offer.endpoint) {
    return { environment: current, reusedPairing: true, endpointChanged: false }
  }
  // Why no pairingRevision bump: the credential is unchanged, so clients holding it stay valid.
  const { connectionDependency: _previousDependency, ...rest } = persisted
  const next = {
    ...rest,
    ...getPairingConnectionDependency(current.connectionDependency, offer),
    updatedAt: now,
    endpoints: persisted.endpoints.map((entry) =>
      entry.id === preferred.id ? { ...entry, endpoint: offer.endpoint } : entry
    )
  }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments.map((entry) => (entry.id === persisted.id ? next : entry))
  })
  return {
    environment: resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), current.id),
    reusedPairing: true,
    endpointChanged: true
  }
}
