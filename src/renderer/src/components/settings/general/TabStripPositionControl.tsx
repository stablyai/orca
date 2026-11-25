import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  normalizeTabStripPosition,
  type TabStripPosition
} from '../../../../../shared/workspace-layout/tab-strip-position'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import type { SettingsSearchEntry } from '../search/settings-search'
import { useTranslate } from '@/i18n/use-translate'

/** Tab position: Top (the strip above each split) or Left (Chrome-style vertical tab list). */
export function TabStripPositionControl({
  entry,
  settings,
  updateSettings
}: {
  entry: SettingsSearchEntry
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting {...entry} className="max-w-none">
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <SettingsSegmentedControl<TabStripPosition>
            ariaLabel={entry.title}
            value={normalizeTabStripPosition(settings.tabStripPosition)}
            onChange={(tabStripPosition) => void updateSettings({ tabStripPosition })}
            options={[
              {
                value: 'top',
                label: t(
                  'auto.components.settings.general.TabStripPositionControl.be0f9ce5f5',
                  'Top'
                )
              },
              {
                value: 'left',
                label: t(
                  'auto.components.settings.general.TabStripPositionControl.eb473e14e6',
                  'Left'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
