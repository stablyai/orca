import { useSyncExternalStore } from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

export function getProviderRuntimeContextKey(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  return getEnvironmentRuntimeContextKey(settings?.activeRuntimeEnvironmentId?.trim() || null)
}

/** Context key for an explicit owner; `null` is this app. */
export function getEnvironmentRuntimeContextKey(environmentId: string | null): string {
  return `${getEnvironmentRuntimeIdentityKey(environmentId)}#${providerRuntimeSessionGeneration}`
}

/** The owner without the session generation, for preferences that must outlive a reconnect. */
export function getEnvironmentRuntimeIdentityKey(environmentId: string | null): string {
  return environmentId ? `runtime:${environmentId}` : 'local'
}

/** Whether a context key from {@link getEnvironmentRuntimeContextKey} names a paired server. */
export function isEnvironmentRuntimeContextKey(key: string | null | undefined): boolean {
  return key?.startsWith('runtime:') ?? false
}

export function hasRemoteProviderRuntime(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): boolean {
  return Boolean(settings?.activeRuntimeEnvironmentId?.trim())
}

let providerRuntimeSessionGeneration = 0
const providerRuntimeSessionGenerationListeners = new Set<() => void>()

function notifyProviderRuntimeSessionGeneration(): void {
  for (const listener of providerRuntimeSessionGenerationListeners) {
    listener()
  }
}

export function subscribeProviderRuntimeSessionGeneration(listener: () => void): () => void {
  providerRuntimeSessionGenerationListeners.add(listener)
  return () => {
    providerRuntimeSessionGenerationListeners.delete(listener)
  }
}

export function getProviderRuntimeSessionGeneration(): number {
  return providerRuntimeSessionGeneration
}

export function useProviderRuntimeSessionGeneration(): number {
  return useSyncExternalStore(
    subscribeProviderRuntimeSessionGeneration,
    getProviderRuntimeSessionGeneration,
    getProviderRuntimeSessionGeneration
  )
}

export function useEnvironmentRuntimeContextKey(environmentId: string | null): string {
  const generation = useProviderRuntimeSessionGeneration()
  return `${getEnvironmentRuntimeIdentityKey(environmentId)}#${generation}`
}

export function bumpProviderRuntimeSessionGeneration(): number {
  providerRuntimeSessionGeneration += 1
  notifyProviderRuntimeSessionGeneration()
  return providerRuntimeSessionGeneration
}

export function resetProviderRuntimeSessionGenerationForTests(): void {
  providerRuntimeSessionGeneration = 0
  notifyProviderRuntimeSessionGeneration()
}
