import { invokeNative, isTauriNativeHost } from './tauri-native-host'
import { callRuntimeResult } from './runtime/client/web-runtime-calls'

/** Mirrors `restartLocalTerminalsAfterElevation`: after an elevated relaunch
 *  the helper passes the marker, and local terminals must run under the new
 *  token, so restart the owned persistent daemon once per process. Every
 *  other boot is a no-op, and a failed restart never breaks startup. */
export async function consumeElevationRestartRequest(): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  let requested = false
  try {
    requested = await invokeNative<boolean>('poc_take_elevation_restart_request')
  } catch {
    return
  }
  if (!requested) {
    return
  }
  let elevated: boolean | null = null
  try {
    elevated = await window.api.app.getWindowsAdministratorStatus()
  } catch {
    return
  }
  if (elevated !== true) {
    return
  }
  try {
    await callRuntimeResult('terminalDaemon.restart')
  } catch (error) {
    console.warn(
      '[tauri] Elevation daemon restart failed:',
      error instanceof Error ? error.message : String(error)
    )
  }
}
