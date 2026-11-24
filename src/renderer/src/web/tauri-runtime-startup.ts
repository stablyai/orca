import { invokeNative, isTauriNativeHost } from './tauri-native-host'
import { parseWebPairingInput } from './pairing/web-pairing'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { readJson, writeJson, SETTINGS_STORAGE_KEY } from './preload-api/web-storage'
import {
  createStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from './pairing/web-runtime-environment'
import {
  closeActiveRuntimeClients,
  manuallyDisconnectedEnvironmentIds,
  webRuntimeState
} from './runtime/client/web-runtime-session'

const RUNTIME_PAIRING_RETRY_DELAYS_MS = [500, 1500]

// The settings partition bootstrap persists without invoking the focus readers.
const ACTIVE_RUNTIME_ENVIRONMENT_ID_KEY = 'activeRuntimeEnvironmentId' as const

async function requestTauriRuntimePairingWithRetry(): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RUNTIME_PAIRING_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await invokeNative<string>('poc_runtime_pairing')
    } catch (error) {
      lastError = error
      const delayMs = RUNTIME_PAIRING_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined) {
        break
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

// Why standalone state: bootstrap must know the init failed after catching it,
// so WebRoot can hold the App (and its reconnecting runtime client) instead of
// silently reusing the previous launch's stale endpoint.
let tauriRuntimeInitFailure: unknown = null

export function getTauriRuntimeInitFailure(): unknown {
  return tauriRuntimeInitFailure
}

export async function initializeTauriRuntime(): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  try {
    const identityReady = await invokeNative<boolean>(
      'poc_browser_identity_set_renderer_user_agent',
      {
        args: { userAgent: navigator.userAgent }
      }
    )
    if (!identityReady) {
      throw new Error(
        'The Tauri browser identity bridge could not capture the renderer user agent.'
      )
    }
    const pairing = await requestTauriRuntimePairingWithRetry()
    const offer = parseWebPairingInput(pairing)
    if (offer?.scope !== 'runtime') {
      throw new Error('The local runtime did not provide a runtime pairing offer.')
    }
    // Import before mounting: never reconnect to a stale port/key from the previous launch.
    const environment = createStoredWebRuntimeEnvironment({
      name: 'Orca Local',
      offer,
      previousEnvironment: readStoredWebRuntimeEnvironment()
    })
    closeActiveRuntimeClients()
    manuallyDisconnectedEnvironmentIds.clear()
    webRuntimeState.activeEnvironment = environment
    saveStoredWebRuntimeEnvironment(environment)
    // Tauri owns the paired runtime, so local workspace rows must route through it rather than the
    // browser-only local/SSH transport. Persist this before App mounts and hydrates its catalogs.
    // Why partitioned write: bootstrap owns the fresh pairing (a creation flow with no source row),
    // so it stores the id directly instead of routing through the global setting readers.
    const storedSettings = readJson<Partial<GlobalSettings>>(SETTINGS_STORAGE_KEY, {})
    writeJson(SETTINGS_STORAGE_KEY, {
      ...storedSettings,
      [ACTIVE_RUNTIME_ENVIRONMENT_ID_KEY]: environment.id
    })
  } catch (error) {
    tauriRuntimeInitFailure = error
    throw error
  }
  tauriRuntimeInitFailure = null
}
