import type React from 'react'
import type { GlobalSettings, LeftSidebarAppearanceMode } from '../../../../shared/types'
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
          'Left Sidebar Appearance'
        )}
        description={translate(
          'auto.components.settings.AppearancePane.leftSidebarAppearance.rowDescription',
          'Make the left sidebar match your terminal, stay default, or use a tint.'
        )}
        control={
          <SettingsSegmentedControl<LeftSidebarAppearanceMode>
            size="sm"
            value={settings.leftSidebarAppearanceMode ?? 'default'}
            onChange={(leftSidebarAppearanceMode) => updateSettings({ leftSidebarAppearanceMode })}
            ariaLabel={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.title',
              'Left Sidebar Appearance'
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
              'Sidebar Tint'
            )}
            description={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.tintColorDescription',
              'The color mixed into the left sidebar surface.'
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
              'Controls how strongly the tint is mixed into the sidebar.'
            )}
            value={settings.leftSidebarTintOpacity ?? DEFAULT_LEFT_SIDEBAR_TINT_OPACITY}
            defaultValue={DEFAULT_LEFT_SIDEBAR_TINT_OPACITY}
            min={0}
            max={MAX_LEFT_SIDEBAR_TINT_OPACITY}
            step={0.01}
            suffix={`0 to ${MAX_LEFT_SIDEBAR_TINT_OPACITY}`}
            onChange={(leftSidebarTintOpacity) => updateSettings({ leftSidebarTintOpacity })}
          />
        </div>
      ) : null}
    </div>
  )
}
