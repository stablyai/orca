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
      title: translate(
        'auto.components.settings.computerUseSummary.checkingTitle',
        'Checking Computer Use access.'
      ),
      description: translate(
        'auto.components.settings.computerUseSummary.checkingDescription',
        'Orca is checking macOS privacy permissions for the Computer Use helper.'
      )
    }
  }
  if (setupUnavailable) {
    return {
      title: translate(
        'auto.components.settings.computerUseSummary.unavailableTitle',
        'Computer Use is unavailable.'
      ),
      description: translate(
        'auto.components.settings.computerUseSummary.unavailableDescription',
        'Computer Use permissions are unavailable because {{value0}}.',
        { value0: helperUnavailableReason }
      )
    }
  }
  if (allGranted) {
    return {
      title: translate(
        'auto.components.settings.computerUseSummary.readyTitle',
        'Computer Use is ready.'
      ),
      description: translate(
        'auto.components.settings.computerUseSummary.readyDescription',
        'Agents can inspect and operate app windows when you ask.'
      )
    }
  }
  return {
    title: translate(
      'auto.components.settings.computerUseSummary.permissionsTitle',
      'Finish setup to use local apps.'
    ),
    description: translate(
      'auto.components.settings.computerUseSummary.permissionsRequired',
      '{{value0}} permission{{value1}} required before agents can operate app windows.',
      {
        value0: requiredPermissionCount,
        value1: requiredPermissionCount === 1 ? '' : 's'
      }
    )
  }
}
