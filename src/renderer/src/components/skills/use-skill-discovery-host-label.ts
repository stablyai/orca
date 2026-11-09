import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'

/** Name the scanned owner for the page-wide sharing restriction; return null while ownership is unresolved. */
export function useSkillDiscoveryHostLabel(target: RuntimeClientTarget | null): string | null {
  const t = useTranslate()
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
    return t('auto.components.skills.host.local', 'This machine')
  }
  return environmentName ?? t('auto.components.skills.host.remote', 'Connected runtime')
}
