import { useMemo } from 'react'
import { onDeviceTextGenerationSupported } from '../../../shared/on-device-text-generation'

/** Cheap static gate for offering the provider; the model itself is probed when it is used. */
export function useOnDeviceTextGenerationAvailable(): boolean {
  return useMemo(() => {
    try {
      const { platform, arch, osRelease, onDeviceModelInstalled } = window.api.platform.get()
      return onDeviceTextGenerationSupported({
        platform,
        arch,
        osRelease,
        helperInstalled: onDeviceModelInstalled
      })
    } catch {
      // Preload-less surfaces (SSR tests, web client) simply never offer the provider.
      return false
    }
  }, [])
}
