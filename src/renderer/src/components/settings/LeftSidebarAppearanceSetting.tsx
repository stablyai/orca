import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { LeftSidebarAppearanceMode } from '../../../../shared/ui-chrome-types'
import {
  DEFAULT_LEFT_SIDEBAR_TINT_COLOR,
  DEFAULT_LEFT_SIDEBAR_TINT_OPACITY,
  MAX_LEFT_SIDEBAR_TINT_OPACITY
} from '../../../../shared/left-sidebar-appearance'
import { translate } from '@/i18n/i18n'
import {
  ColorField,
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from './SettingsFormControls'

type LeftSidebarAppearanceSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function LeftSidebarAppearanceSetting({
  settings,
  updateSettings
}: LeftSidebarAppearanceSettingProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <SettingsRow
        alignTop
        label={translate(
          'auto.components.settings.AppearancePane.leftSidebarAppearance.title',
          'App Appearance'
        )}
        description={translate(
          'auto.components.settings.AppearancePane.leftSidebarAppearance.rowDescription',
          "Make Orca's interface match your terminal, stay default, or use a tint."
        )}
        control={
          <SettingsSegmentedControl<LeftSidebarAppearanceMode>
            size="sm"
            value={settings.leftSidebarAppearanceMode ?? 'default'}
            onChange={(leftSidebarAppearanceMode) => updateSettings({ leftSidebarAppearanceMode })}
            ariaLabel={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.title',
              'App Appearance'
            )}
            options={[
              {
                value: 'default',
                label: translate(
                  'auto.components.settings.AppearancePane.leftSidebarAppearance.default',
                  'Default'
                )
              },
              {
                value: 'match-terminal',
                label: translate(
                  'auto.components.settings.AppearancePane.leftSidebarAppearance.matchTerminal',
                  'Match Terminal'
                )
              },
              {
                value: 'tinted',
                label: translate(
                  'auto.components.settings.AppearancePane.leftSidebarAppearance.tinted',
                  'Tinted'
                )
              }
            ]}
          />
        }
      />
      {(settings.leftSidebarAppearanceMode ?? 'default') === 'tinted' ? (
        <div className="space-y-2">
          <ColorField
            label={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.tintColor',
              'App Tint'
            )}
            description={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.tintColorDescription',
              "The color mixed into Orca's interface."
            )}
            value={settings.leftSidebarTintColor ?? DEFAULT_LEFT_SIDEBAR_TINT_COLOR}
            fallback={DEFAULT_LEFT_SIDEBAR_TINT_COLOR}
            onChange={(leftSidebarTintColor) => updateSettings({ leftSidebarTintColor })}
          />
          <NumberField
            label={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.tintOpacity',
              'Tint Strength'
            )}
            description={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.tintOpacityDescription',
              "Controls how strongly the tint is mixed into Orca's interface."
            )}
            value={settings.leftSidebarTintOpacity ?? DEFAULT_LEFT_SIDEBAR_TINT_OPACITY}
            defaultValue={DEFAULT_LEFT_SIDEBAR_TINT_OPACITY}
            min={0}
            max={MAX_LEFT_SIDEBAR_TINT_OPACITY}
            step={0.01}
            suffix={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.tintOpacityRange',
              '0 to {{value0}}',
              { value0: MAX_LEFT_SIDEBAR_TINT_OPACITY }
            )}
            onChange={(leftSidebarTintOpacity) => updateSettings({ leftSidebarTintOpacity })}
          />
        </div>
      ) : null}
    </div>
  )
}
