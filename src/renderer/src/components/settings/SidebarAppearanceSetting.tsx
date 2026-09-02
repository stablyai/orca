import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SidebarAppearanceMode } from '../../../../shared/ui-chrome-types'
import {
  DEFAULT_SIDEBAR_TINT_COLOR,
  DEFAULT_SIDEBAR_TINT_OPACITY,
  MAX_SIDEBAR_TINT_OPACITY
} from '../../../../shared/sidebar-appearance'
import { translate } from '@/i18n/i18n'
import {
  ColorField,
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from './SettingsFormControls'

type SidebarAppearanceSettingProps = {
  side: 'left' | 'right'
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function getSidebarAppearanceCopy(side: 'left' | 'right'): {
  title: string
  description: string
  tintDescription: string
} {
  if (side === 'left') {
    return {
      title: translate(
        'auto.components.settings.AppearancePane.leftSidebarAppearance.title',
        'Left Sidebar Appearance'
      ),
      description: translate(
        'auto.components.settings.AppearancePane.leftSidebarAppearance.rowDescription',
        'Make the left sidebar match your terminal, stay default, or use a tint.'
      ),
      tintDescription: translate(
        'auto.components.settings.AppearancePane.leftSidebarAppearance.tintColorDescription',
        'The color mixed into the left sidebar surface.'
      )
    }
  }
  return {
    title: translate(
      'auto.components.settings.AppearancePane.rightSidebarAppearance.title',
      'Right Sidebar Appearance'
    ),
    description: translate(
      'auto.components.settings.AppearancePane.rightSidebarAppearance.rowDescription',
      'Make the right sidebar match your terminal, stay default, or use a tint.'
    ),
    tintDescription: translate(
      'auto.components.settings.AppearancePane.rightSidebarAppearance.tintColorDescription',
      'The color mixed into the right sidebar surface.'
    )
  }
}

export function SidebarAppearanceSetting({
  side,
  settings,
  updateSettings
}: SidebarAppearanceSettingProps): React.JSX.Element {
  const copy = getSidebarAppearanceCopy(side)
  const appearanceMode =
    side === 'left'
      ? settings.leftSidebarAppearanceMode
      : (settings.rightSidebarAppearanceMode ?? 'default')
  const tintColor = side === 'left' ? settings.leftSidebarTintColor : settings.rightSidebarTintColor
  const tintOpacity =
    side === 'left' ? settings.leftSidebarTintOpacity : settings.rightSidebarTintOpacity

  const updateAppearanceMode = (mode: SidebarAppearanceMode): void => {
    updateSettings(
      side === 'left' ? { leftSidebarAppearanceMode: mode } : { rightSidebarAppearanceMode: mode }
    )
  }
  const updateTintColor = (color: string): void => {
    updateSettings(
      side === 'left' ? { leftSidebarTintColor: color } : { rightSidebarTintColor: color }
    )
  }
  const updateTintOpacity = (opacity: number): void => {
    updateSettings(
      side === 'left' ? { leftSidebarTintOpacity: opacity } : { rightSidebarTintOpacity: opacity }
    )
  }

  return (
    <div className="space-y-2">
      <SettingsRow
        alignTop
        label={copy.title}
        description={copy.description}
        control={
          <SettingsSegmentedControl<SidebarAppearanceMode>
            size="sm"
            value={appearanceMode}
            onChange={updateAppearanceMode}
            ariaLabel={copy.title}
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
      {appearanceMode === 'tinted' ? (
        <div className="space-y-2">
          <ColorField
            label={translate(
              'auto.components.settings.AppearancePane.leftSidebarAppearance.tintColor',
              'Sidebar Tint'
            )}
            description={copy.tintDescription}
            value={tintColor ?? DEFAULT_SIDEBAR_TINT_COLOR}
            fallback={DEFAULT_SIDEBAR_TINT_COLOR}
            onChange={updateTintColor}
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
            value={tintOpacity ?? DEFAULT_SIDEBAR_TINT_OPACITY}
            defaultValue={DEFAULT_SIDEBAR_TINT_OPACITY}
            min={0}
            max={MAX_SIDEBAR_TINT_OPACITY}
            step={0.01}
            suffix={`0 to ${MAX_SIDEBAR_TINT_OPACITY}`}
            onChange={updateTintOpacity}
          />
        </div>
      ) : null}
    </div>
  )
}
