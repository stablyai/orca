import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { LeftSidebarAppearanceMode } from '../../../../../shared/ui-chrome-types'
import {
  DEFAULT_LEFT_SIDEBAR_TINT_COLOR,
  DEFAULT_LEFT_SIDEBAR_TINT_OPACITY,
  MAX_LEFT_SIDEBAR_TINT_OPACITY
} from '../../../../../shared/left-sidebar-appearance'
import { useTranslate } from '@/i18n/use-translate'
import {
  ColorField,
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from '../form-controls/SettingsFormControls'

type LeftSidebarAppearanceSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function LeftSidebarAppearanceSetting({
  settings,
  updateSettings
}: LeftSidebarAppearanceSettingProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      <SettingsRow
        alignTop
        label={t(
          'auto.components.settings.AppearancePane.leftSidebarAppearance.fcc653abee',
          'Left sidebar appearance'
        )}
        description={t(
          'auto.components.settings.AppearancePane.leftSidebarAppearance.tintDescription',
          'Keep the left sidebar default or tint it. To follow the terminal, pick Match Terminal as the Light or Dark theme.'
        )}
        control={
          <SettingsSegmentedControl<LeftSidebarAppearanceMode>
            size="sm"
            value={settings.leftSidebarAppearanceMode === 'tinted' ? 'tinted' : 'default'}
            onChange={(leftSidebarAppearanceMode) => updateSettings({ leftSidebarAppearanceMode })}
            ariaLabel={t(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.fcc653abee',
              'Left sidebar appearance'
            )}
            options={[
              {
                value: 'default',
                label: t(
                  'auto.components.settings.AppearancePane.leftSidebarAppearance.default',
                  'Default'
                )
              },
              {
                value: 'tinted',
                label: t(
                  'auto.components.settings.AppearancePane.leftSidebarAppearance.tinted',
                  'Tinted'
                )
              }
            ]}
          />
        }
      />
      {settings.leftSidebarAppearanceMode === 'tinted' ? (
        <div className="space-y-2">
          <ColorField
            label={t(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.ba1d9a0607',
              'Sidebar tint'
            )}
            description={t(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.tintColorDescription',
              'The color mixed into the left sidebar surface.'
            )}
            value={settings.leftSidebarTintColor ?? DEFAULT_LEFT_SIDEBAR_TINT_COLOR}
            fallback={DEFAULT_LEFT_SIDEBAR_TINT_COLOR}
            onChange={(leftSidebarTintColor) => updateSettings({ leftSidebarTintColor })}
          />
          <NumberField
            label={t(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.df205a675e',
              'Tint strength'
            )}
            description={t(
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
