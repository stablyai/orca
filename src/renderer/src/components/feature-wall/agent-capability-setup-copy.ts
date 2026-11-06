import { translate } from '@/i18n/i18n'

export function capabilitiesSetupBusyLabel(): string {
  return translate(
    'auto.components.feature.wall.AgentCapabilitiesSetupAction.settingUp',
    'Setting up capabilities...'
  )
}

export function capabilityToggleLabel(selected: boolean, title: string): string {
  return selected
    ? translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.disableRow',
        'Disable {{title}}',
        {
          title
        }
      )
    : translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.enableRow',
        'Enable {{title}}',
        {
          title
        }
      )
}
