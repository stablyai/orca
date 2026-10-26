import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

/** Name the scanned owner for the page-wide sharing restriction; return null while ownership is unresolved. */
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
