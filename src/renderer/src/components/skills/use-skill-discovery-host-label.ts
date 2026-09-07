import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

/**
 * Names the machine whose skill folders were scanned, so a remote or WSL user
 * can tell at a glance why sharing is unavailable without reading a per-row
 * sentence. Returns null while the owning runtime is still unknown.
 */
export function useSkillDiscoveryHostLabel(target: RuntimeClientTarget | null): string | null {
  const environmentName = useAppStore((state) =>
    target?.kind === 'environment'
      ? (state.runtimeEnvironments.find((environment) => environment.id === target.environmentId)
          ?.name ?? null)
      : null
  )
  if (!target) {
    return null
  }
  if (target.kind === 'local') {
    return translate('auto.components.skills.host.local', 'This machine')
  }
  return environmentName ?? translate('auto.components.skills.host.remote', 'Connected runtime')
}
