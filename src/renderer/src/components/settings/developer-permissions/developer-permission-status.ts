import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  DeveloperPermissionId,
  DeveloperPermissionStatus
} from '../../../../../shared/developer-permissions-types'

export function developerPermissionStatusLabel(
  id: DeveloperPermissionId,
  status: DeveloperPermissionStatus | undefined,
  t: Translate = translate
): string {
  switch (status) {
    case 'granted':
      return t('auto.components.settings.DeveloperPermissionsPane.statusGranted', 'Granted')
    case 'denied':
      return t('auto.components.settings.DeveloperPermissionsPane.statusDenied', 'Denied')
    case 'not-determined':
      return t(
        'auto.components.settings.DeveloperPermissionsPane.statusNotRequested',
        'Not requested'
      )
    case 'restricted':
      return t('auto.components.settings.DeveloperPermissionsPane.statusRestricted', 'Restricted')
    case 'unsupported':
      return t('auto.components.settings.DeveloperPermissionsPane.statusUnsupported', 'macOS only')
    case 'ready':
      return t('auto.components.settings.DeveloperPermissionsPane.statusEntitled', 'Entitled')
    case 'unknown':
    case undefined:
      if (id === 'local-network') {
        return t(
          'auto.components.settings.DeveloperPermissionsPane.statusManagedByMacOS',
          'Managed by macOS'
        )
      }
      return t(
        'auto.components.settings.DeveloperPermissionsPane.statusCheckManually',
        'Check manually'
      )
  }
}

export function developerPermissionStatusClass(
  status: DeveloperPermissionStatus | undefined
): string {
  if (status === 'granted' || status === 'ready') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  if (status === 'denied' || status === 'restricted') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  return 'border-border bg-muted text-muted-foreground'
}
