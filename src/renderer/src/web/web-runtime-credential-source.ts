import {
  DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY,
  DEVICE_KEY_RUNTIME_CAPABILITY
} from '../../../shared/device-key-capability'
import {
  createSessionDeviceSigningKey,
  getOrCreatePendingWebDeviceKey,
  webDeviceSigningKey,
  type KeyedWebDeviceKeySupport,
  type WebDeviceSigningKey
} from './web-device-key'
import { webDeviceKeyId, type WebDeviceKeyStore } from './web-device-key-store'

export const MIGRATED_DEVICE_TOKEN_PREFIX = 'migrated:'

/** How the next socket authenticates. */
export type WebRuntimeAuthPlan =
  | { kind: 'legacy-token'; deviceToken: string }
  // A v2 token session whose only job is to register `key`, then reconnect with it.
  | {
      kind: 'migrate'
      deviceToken: string
      key: WebDeviceSigningKey
      ephemeral: boolean
      requiredCapabilities: readonly string[]
    }
  | { kind: 'device-key'; deviceId: string; key: WebDeviceSigningKey }

export type WebRuntimeCredentialSource = {
  /** Helper sockets pass false so only the primary socket ever registers a key. Synchronous
   *  when no key store is read, so a token-only socket opens in the same task as before. */
  nextPlan(allowMigration: boolean): WebRuntimeAuthPlan | Promise<WebRuntimeAuthPlan>
  /** The host forked `deviceId` for the plan's key; the token may now be forgotten. */
  migrated(plan: Extract<WebRuntimeAuthPlan, { kind: 'migrate' }>, deviceId: string): Promise<void>
  /** This host cannot take a key right now; stay on the token for this page load. */
  migrationUnavailable(): void
  /** A sealed device_revoked naming `deviceId`: delete the key only if it is ours. */
  deviceRevoked(deviceId: string): Promise<boolean>
}

/** Today's behaviour: a bearer token over legacy framing. */
export function tokenOnlyCredentialSource(deviceToken: string): WebRuntimeCredentialSource {
  return {
    nextPlan: () => ({ kind: 'legacy-token', deviceToken }),
    migrated: async () => {},
    migrationUnavailable: () => {},
    deviceRevoked: async () => false
  }
}

export type WebRuntimeCredentialEnvironment = {
  environmentId: string
  hostPublicKeyB64: string
  deviceToken: string
  pairingRevision: number
  /**
   * persisted: the pairing lives in localStorage (existing pairings, kept working as-is when
   * no persistent key is possible). session: memory only, never written to disk.
   */
  storage: 'persisted' | 'session'
}

export function createWebRuntimeCredentialSource(args: {
  environment: WebRuntimeCredentialEnvironment
  support: KeyedWebDeviceKeySupport
  store: WebDeviceKeyStore
  subtle: SubtleCrypto | null
  /** Durably replace the stored token with a placeholder once the key is active. */
  forgetStoredToken: (deviceId: string) => void
  /** The key is gone (revoked); drop the pairing so the user re-pairs. */
  forgetPairing: () => void
}): WebRuntimeCredentialSource {
  const { environment, support, store, subtle } = args
  const recordId = webDeviceKeyId(environment.hostPublicKeyB64, environment.environmentId)
  let unavailable = false
  let tokenForgotten = environment.deviceToken.startsWith(MIGRATED_DEVICE_TOKEN_PREFIX)
  let sessionKey: { key: WebDeviceSigningKey; deviceId?: string } | null = null
  const legacy = (): WebRuntimeAuthPlan => ({
    kind: 'legacy-token',
    deviceToken: environment.deviceToken
  })

  const persistentPlan = (
    allowMigration: boolean
  ): WebRuntimeAuthPlan | Promise<WebRuntimeAuthPlan> =>
    // Why no store read: a code that never migrated must connect even if IndexedDB is broken.
    !subtle || (!tokenForgotten && (!allowMigration || unavailable))
      ? legacy()
      : storedKeyPlan(subtle)

  const storedKeyPlan = async (keySubtle: SubtleCrypto): Promise<WebRuntimeAuthPlan> => {
    let existing = await store.get(recordId)
    const recordRevision = existing?.pairingRevision ?? -Infinity
    // Why: another tab re-paired since this tab loaded; its key is not ours to use or delete.
    if (existing && recordRevision > environment.pairingRevision) {
      return legacy()
    }
    // Why: a re-pair saved a fresh code; a key from an earlier pairing may be refused for good.
    if (existing && recordRevision < environment.pairingRevision && !tokenForgotten) {
      await store.remove(recordId)
      existing = undefined
    }
    if (existing?.state === 'active' && existing.deviceId) {
      // Why: another tab (or a run that closed mid-migration) activated the key; drop the code.
      if (!tokenForgotten) {
        tokenForgotten = true
        args.forgetStoredToken(existing.deviceId)
      }
      return {
        kind: 'device-key',
        deviceId: existing.deviceId,
        key: webDeviceSigningKey(keySubtle, existing)
      }
    }
    if (tokenForgotten) {
      return legacy()
    }
    const record = await getOrCreatePendingWebDeviceKey(
      store,
      keySubtle,
      recordId,
      environment.pairingRevision
    )
    return {
      kind: 'migrate',
      deviceToken: environment.deviceToken,
      key: webDeviceSigningKey(keySubtle, record),
      ephemeral: false,
      requiredCapabilities: [DEVICE_KEY_RUNTIME_CAPABILITY]
    }
  }

  const sessionPlan = (allowMigration: boolean): WebRuntimeAuthPlan => {
    if (sessionKey?.deviceId) {
      return { kind: 'device-key', deviceId: sessionKey.deviceId, key: sessionKey.key }
    }
    // Why: an existing stored pairing keeps its token exactly as before; it is never cut.
    if (!allowMigration || unavailable || environment.storage !== 'session' || tokenForgotten) {
      return legacy()
    }
    sessionKey ??= { key: createSessionDeviceSigningKey() }
    return {
      kind: 'migrate',
      deviceToken: environment.deviceToken,
      key: sessionKey.key,
      ephemeral: true,
      requiredCapabilities: [DEVICE_KEY_RUNTIME_CAPABILITY, DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY]
    }
  }

  return {
    nextPlan: (allowMigration) =>
      support === 'persistent' ? persistentPlan(allowMigration) : sessionPlan(allowMigration),
    migrated: async (plan, deviceId) => {
      if (plan.ephemeral) {
        sessionKey = { key: plan.key, deviceId }
      } else {
        const record = await store.get(recordId)
        if (!record || record.publicKeyB64 !== plan.key.publicKeyB64) {
          throw new Error('The device key changed while it was being registered')
        }
        // Why first: the token is deleted only after the key record is durably active.
        await store.put({ ...record, state: 'active', deviceId })
      }
      tokenForgotten = true
      args.forgetStoredToken(deviceId)
    },
    migrationUnavailable: () => {
      unavailable = true
    },
    deviceRevoked: async (deviceId) => {
      if (sessionKey?.deviceId === deviceId) {
        sessionKey = null
        args.forgetPairing()
        return true
      }
      const record = support === 'persistent' ? await store.get(recordId) : undefined
      if (!record || record.deviceId !== deviceId) {
        return false
      }
      await store.remove(recordId)
      args.forgetPairing()
      return true
    }
  }
}

// Why: the host refuses any request token on a socket that authenticated with a key.
export function withoutTokenOnKeyedSocket(
  plan: WebRuntimeAuthPlan | null,
  message: unknown
): unknown {
  if (plan?.kind !== 'device-key' || !message || typeof message !== 'object') {
    return message
  }
  return Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'deviceToken'))
}

/** Opens with the next plan: in the same task when no key store is read, as before keys. */
export function withWebRuntimeAuthPlan(
  source: WebRuntimeCredentialSource,
  allowMigration: boolean,
  open: (plan: WebRuntimeAuthPlan) => void,
  // Neither plan could be built (e.g. IndexedDB broken for a migrated pairing): retry later.
  onUnavailable: () => void
): void {
  let planned: WebRuntimeAuthPlan | Promise<WebRuntimeAuthPlan>
  try {
    planned = source.nextPlan(allowMigration)
  } catch (error) {
    planned = Promise.reject(error)
  }
  if (!(planned instanceof Promise)) {
    open(planned)
    return
  }
  void planned
    .catch((error: unknown) => {
      console.warn('[web] Device key unavailable; using the pairing code.', error)
      source.migrationUnavailable()
      return source.nextPlan(false)
    })
    .then(open, (error: unknown) => {
      console.warn('[web] Device key store unavailable; will retry.', error)
      onUnavailable()
    })
}
