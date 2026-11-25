import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  getProviderAccountScope,
  getProviderRateLimitScope,
  type ProviderHostScope
} from './provider-account-scope'

function useScopeServerName(target: RuntimeClientTarget): string | null {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  return useAppStore((state) =>
    environmentId
      ? (state.runtimeEnvironments.find((environment) => environment.id === environmentId)?.name ??
        null)
      : null
  )
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
