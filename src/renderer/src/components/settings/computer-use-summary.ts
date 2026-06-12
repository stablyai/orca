import { translate } from '@/i18n/i18n'

type ComputerUseSummaryInput = {
  checking: boolean
  setupUnavailable: boolean
  allGranted: boolean
  helperUnavailableReason: string | null
  requiredPermissionCount: number
}

export function getComputerUseSummary({
  checking,
  setupUnavailable,
  allGranted,
  helperUnavailableReason,
  requiredPermissionCount
}: ComputerUseSummaryInput): { title: string; description: string } {
  if (checking) {
    return {
      title: 'Checking Computer Use access.',
      description: 'Orca is checking macOS privacy permissions for the Computer Use helper.'
    }
  }
  if (setupUnavailable) {
    return {
      title: 'Computer Use is unavailable.',
      description: `Computer Use permissions are unavailable because ${helperUnavailableReason}.`
    }
  }
  if (allGranted) {
    return {
      title: 'Computer Use is ready.',
      description: 'Agents can inspect and operate app windows when you ask.'
    }
  }
  return {
    title: 'Finish setup to use local apps.',
    description: translate(
      'auto.components.settings.computerUseSummary.permissionsRequired',
      `${requiredPermissionCount} permission${
        requiredPermissionCount === 1 ? '' : 's'
      } required before agents can operate app windows.`
    )
  }
}
