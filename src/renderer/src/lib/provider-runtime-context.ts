import type { GlobalSettings } from '../../../shared/global-settings-types'

export function getProviderRuntimeContextKey(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  return getEnvironmentRuntimeContextKey(settings?.activeRuntimeEnvironmentId?.trim() || null)
}

/** Context key for an explicit owner; `null` is this app. */
export function getEnvironmentRuntimeContextKey(environmentId: string | null): string {
  const baseKey = environmentId ? `runtime:${environmentId}` : 'local'
  return `${baseKey}#${providerRuntimeSessionGeneration}`
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

export function bumpProviderRuntimeSessionGeneration(): number {
  providerRuntimeSessionGeneration += 1
  return providerRuntimeSessionGeneration
}
