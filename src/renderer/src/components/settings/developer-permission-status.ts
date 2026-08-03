import { translate } from '@/i18n/i18n'
import type { DeveloperPermissionStatus } from '../../../../shared/developer-permissions-types'

/** Status copy and tone for the macOS developer permission rows. */
export function developerPermissionStatusLabel(
  status: DeveloperPermissionStatus | undefined
): string {
  switch (status) {
    case 'granted':
      return translate('auto.components.settings.DeveloperPermissionsPane.statusGranted', 'Granted')
    case 'denied':
      return translate('auto.components.settings.DeveloperPermissionsPane.statusDenied', 'Denied')
    case 'not-determined':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.statusNotRequested',
        'Not requested'
      )
    case 'restricted':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.statusRestricted',
        'Restricted'
      )
    case 'unsupported':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.statusUnsupported',
        'macOS only'
      )
    case 'ready':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.statusEntitled',
        'Entitled'
      )
    case 'unknown':
    case undefined:
      return translate(
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
