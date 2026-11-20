import { invokeNative, isTauriNativeHost } from './tauri-native-host'
import { parseWebPairingInput } from './pairing/web-pairing'
import {
  createStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from './pairing/web-runtime-environment'
import {
  getStoredSettings,
  writeStoredSettings
} from './preload-api/preferences/web-preferences-store'

export async function initializeTauriRuntime(): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  const identityReady = await invokeNative<boolean>(
    'poc_browser_identity_set_renderer_user_agent',
    {
      args: { userAgent: navigator.userAgent }
    }
  )
  if (!identityReady) {
    throw new Error('The Tauri browser identity bridge could not capture the renderer user agent.')
  }
  const pairing = await invokeNative<string>('poc_runtime_pairing')
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
  saveStoredWebRuntimeEnvironment(environment)
  // Tauri owns the paired runtime, so local workspace rows must route through it rather than the
  // browser-only local/SSH transport. Persist this before App mounts and hydrates its catalogs.
  writeStoredSettings(getStoredSettings(), environment.id)
}
