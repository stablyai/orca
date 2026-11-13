import React from 'react'
import { TAB_STRIP_PLACEMENT, type TabStripPlacement } from '../../../../../shared/tab-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { getTabStripPlacementSearchEntry } from './tab-strip-placement-search'
import { useTranslate } from '@/i18n/use-translate'

export function TabStripPlacementControl({
  tabStripPlacement,
  updateSettings
}: {
  tabStripPlacement: TabStripPlacement
  updateSettings: (updates: { tabStripPlacement?: TabStripPlacement }) => Promise<void> | void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('auto.components.settings.TabStripPlacementControl.title', 'Tab Placement')
  return (
    <SearchableSetting
      title={title}
      description={t(
        'auto.components.settings.TabStripPlacementControl.description',
        'Show tabs in the top strip, or in a resizable panel on the right.'
      )}
      keywords={getTabStripPlacementSearchEntry().keywords}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        control={
          <Select
            value={tabStripPlacement}
            onValueChange={(value) =>
              void updateSettings({
                tabStripPlacement:
                  value === TAB_STRIP_PLACEMENT.rightPanel
                    ? TAB_STRIP_PLACEMENT.rightPanel
                    : TAB_STRIP_PLACEMENT.top
              })
            }
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TAB_STRIP_PLACEMENT.top}>
                {t('auto.components.settings.TabStripPlacementControl.top', 'Top strip')}
              </SelectItem>
              <SelectItem value={TAB_STRIP_PLACEMENT.rightPanel}>
                {t('auto.components.settings.TabStripPlacementControl.rightPanel', 'Right panel')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
