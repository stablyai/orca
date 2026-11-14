import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function capabilitiesSetupBusyLabel(): string {
  return translate(
    'auto.components.feature.wall.AgentCapabilitiesSetupAction.settingUp',
    'Setting up capabilities...'
  )
}

export function capabilityToggleLabel(
  selected: boolean,
  title: string,
  t: Translate = translate
): string {
  return selected
    ? t(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.disableRow',
        'Disable {{title}}',
        {
          title
        }
      )
    : t('auto.components.feature.wall.AgentCapabilitiesSetupAction.enableRow', 'Enable {{title}}', {
        title
      })
}
