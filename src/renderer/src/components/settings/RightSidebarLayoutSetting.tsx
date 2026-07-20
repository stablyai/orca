import type React from 'react'

import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getRightSidebarLayoutEntry } from './appearance-sidebar-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'

type RightSidebarLayoutSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}

export function RightSidebarLayoutSetting({
  settings,
  updateSettings,
  forceVisible
}: RightSidebarLayoutSettingProps): React.JSX.Element {
  const entry = getRightSidebarLayoutEntry()

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      forceVisible={forceVisible}
    >
      <SettingsRow
        label={entry.title}
        // Why: spell out the tradeoff — overlay covers content but keeps terminals from re-wrapping.
        description={translate(
          'auto.components.settings.AppearanceWindowSidebarSection.rightSidebarLayoutDescription',
          'Overlay floats the sidebar over the workspace so terminals keep their size when it opens.'
        )}
        control={
          <SettingsSegmentedControl
            ariaLabel={entry.title}
            value={settings.rightSidebarLayoutMode === 'overlay' ? 'overlay' : 'push'}
            onChange={(value) =>
              updateSettings({
                rightSidebarLayoutMode: value === 'overlay' ? 'overlay' : 'push'
              })
            }
            options={[
              {
                value: 'push',
                label: translate(
                  'auto.components.settings.AppearanceWindowSidebarSection.rightSidebarLayoutPush',
                  'Push'
                )
              },
              {
                value: 'overlay',
                label: translate(
                  'auto.components.settings.AppearanceWindowSidebarSection.rightSidebarLayoutOverlay',
                  'Overlay'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
