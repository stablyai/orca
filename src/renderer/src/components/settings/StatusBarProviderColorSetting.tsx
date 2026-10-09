import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ColorField, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { getProviderDisplayName } from '../status-bar/tooltip'
import {
  DEFAULT_PROVIDER_COLORS,
  type UsageProvider
} from '../status-bar/status-bar-provider-colors'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keys come from a Record<UsageProvider, string> literal.
const PROVIDERS = Object.keys(DEFAULT_PROVIDER_COLORS) as UsageProvider[]

export function StatusBarProviderColorSetting({
  settings,
  updateSettings
}: Props): React.JSX.Element {
  const enabled = settings.statusBarProviderColorsEnabled === true
  const colors = settings.statusBarProviderColors ?? {}

  return (
    <div>
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.StatusBarProviderColorSetting.title',
          'Color usage by provider'
        )}
        description={translate(
          'auto.components.settings.StatusBarProviderColorSetting.description',
          'Tint each usage meter in the status bar with its AI provider’s color.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ statusBarProviderColorsEnabled: !enabled })}
      />
      {enabled ? (
        <div className="ml-4 border-l border-border pl-4">
          {PROVIDERS.map((provider) => (
            <ColorField
              key={provider}
              label={getProviderDisplayName(provider)}
              description=""
              value={colors[provider] ?? ''}
              fallback={DEFAULT_PROVIDER_COLORS[provider]}
              onChange={(color) =>
                updateSettings({ statusBarProviderColors: { ...colors, [provider]: color } })
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
