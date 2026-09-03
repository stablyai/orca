import type { RuntimeCapability } from '../../../shared/protocol-version'

let localRuntimeCapabilities: readonly RuntimeCapability[] = []
let refreshPromise: Promise<readonly RuntimeCapability[]> | null = null

export function readLocalRuntimeCapabilities(): readonly RuntimeCapability[] {
  return localRuntimeCapabilities
}

export function refreshLocalRuntimeCapabilities(): Promise<readonly RuntimeCapability[]> {
  refreshPromise ??= window.api.runtime
    .getStatus()
    .then((status) => {
      localRuntimeCapabilities = [...(status.capabilities ?? [])]
      return localRuntimeCapabilities
    })
    .catch(() => {
      localRuntimeCapabilities = []
      return localRuntimeCapabilities
    })
    .finally(() => {
      refreshPromise = null
    })
  return refreshPromise
}

export function setLocalRuntimeCapabilitiesForTests(
  capabilities: readonly RuntimeCapability[]
): void {
  localRuntimeCapabilities = [...capabilities]
  refreshPromise = null
}
