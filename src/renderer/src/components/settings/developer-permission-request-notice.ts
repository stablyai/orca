import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { DeveloperPermissionRequestResult } from '../../../../shared/developer-permissions-types'

/** Reports only permission outcomes supported by the corresponding macOS API. */
export function showDeveloperPermissionRequestNotice(
  result: DeveloperPermissionRequestResult,
  openLocalNetworkSettings: () => void
): void {
  if (result.status === 'granted') {
    toast.success(
      translate(
        'auto.components.settings.DeveloperPermissionsPane.48d87edcd2',
        'Permission granted'
      )
    )
    return
  }
  if (result.openedSystemSettings) {
    toast.message(
      translate(
        'auto.components.settings.DeveloperPermissionsPane.fa809e8ada',
        'Opened macOS Privacy & Security'
      )
    )
    return
  }
  if (result.id === 'local-network') {
    toast.message(
      translate(
        'auto.components.settings.DeveloperPermissionsPane.localNetworkPromptCheck',
        'Check for a macOS prompt'
      ),
      {
        description: translate(
          'auto.components.settings.DeveloperPermissionsPane.localNetworkPromptGuidance',
          'If prompted, choose Allow. If no prompt appears, open System Settings and enable Orca under Privacy & Security → Local Network.'
        ),
        action: {
          label: translate(
            'auto.components.settings.DeveloperPermissionsPane.localNetworkOpenSettings',
            'Open System Settings'
          ),
          onClick: openLocalNetworkSettings
        }
      }
    )
    return
  }
  toast.message(
    translate(
      'auto.components.settings.DeveloperPermissionsPane.66e94d6cf3',
      'Permission request sent'
    )
  )
}
