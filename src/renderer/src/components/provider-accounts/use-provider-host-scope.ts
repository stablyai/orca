import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  getProviderAccountScope,
  getProviderRateLimitScope,
  type ProviderHostScope
} from './provider-account-scope'

function createEnvironmentNameSelector(environmentId: string | null) {
  let source: AppState['runtimeEnvironments'] | undefined
  let name: string | null = null
  return (state: AppState): string | null => {
    if (!environmentId) {
      return null
    }
    if (state.runtimeEnvironments !== source) {
      source = state.runtimeEnvironments
      name = source.find((environment) => environment.id === environmentId)?.name ?? null
    }
    return name
  }
}

function useScopeServerName(target: RuntimeClientTarget): string | null {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const selectServerName = useMemo(
    () => createEnvironmentNameSelector(environmentId),
    [environmentId]
  )
  return useAppStore(selectServerName)
}

export function useProviderAccountScope(target: RuntimeClientTarget): ProviderHostScope {
  const t = useTranslate()
  return getProviderAccountScope(target, useScopeServerName(target), t)
}

export function useProviderRateLimitScope(
  target: RuntimeClientTarget,
  providerLabel: string
): ProviderHostScope {
  const t = useTranslate()
  return getProviderRateLimitScope(target, useScopeServerName(target), providerLabel, t)
}
