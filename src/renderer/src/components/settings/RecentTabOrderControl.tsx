import React from 'react'
import type { CtrlTabOrderMode } from '../../../../shared/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'

export function RecentTabOrderControl({
  ctrlTabOrderMode,
  keywords,
  updateSettings
}: {
  ctrlTabOrderMode: CtrlTabOrderMode
  keywords?: string[]
  updateSettings: (updates: { ctrlTabOrderMode?: CtrlTabOrderMode }) => Promise<void> | void
}): React.JSX.Element {
  return (
    <SearchableSetting
      title="Tab Order"
      description="Recent or tab strip."
      keywords={keywords}
      className="max-w-none"
    >
      <SettingsRow
        label="Tab Order"
        control={
          <Select
            value={ctrlTabOrderMode}
            onValueChange={(value) =>
              void updateSettings({ ctrlTabOrderMode: value as CtrlTabOrderMode })
            }
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mru">Most recent</SelectItem>
              <SelectItem value="sequential">Tab strip order</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
