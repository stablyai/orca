import React from 'react'
import { useAppStore } from '@/store'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getCompactProjectRowsEntry } from './appearance-sidebar-search'

export function CompactProjectRowsSetting(): React.JSX.Element {
  const enabled = useAppStore((s) => s.settings?.compactProjectRows === true)
  const setCompactProjectRows = useAppStore((s) => s.setCompactProjectRows)
  const entry = getCompactProjectRowsEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={enabled}
        onChange={() => setCompactProjectRows(!enabled)}
      />
    </SearchableSetting>
  )
}
