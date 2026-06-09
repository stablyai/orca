import React from 'react'
import type { CtrlTabOrderMode } from '../../../../shared/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

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
      title={translate("auto.components.settings.RecentTabOrderControl.7a546f2309", "Tab Order")}
      description={translate("auto.components.settings.RecentTabOrderControl.a867a0889f", "Recent or tab strip.")}
      keywords={keywords}
      className="max-w-none"
    >
      <SettingsRow
        label={translate("auto.components.settings.RecentTabOrderControl.7a546f2309", "Tab Order")}
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
              <SelectItem value="mru">{translate("auto.components.settings.RecentTabOrderControl.6e6a3fcc61", "Most recent")}</SelectItem>
              <SelectItem value="sequential">{translate("auto.components.settings.RecentTabOrderControl.3b17c81ede", "Tab strip order")}</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
