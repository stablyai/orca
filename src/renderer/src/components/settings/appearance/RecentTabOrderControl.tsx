import React from 'react'
import type { CtrlTabOrderMode } from '../../../../../shared/tab-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

export function RecentTabOrderControl({
  ctrlTabOrderMode,
  keywords,
  updateSettings
}: {
  ctrlTabOrderMode: CtrlTabOrderMode
  keywords?: string[]
  updateSettings: (updates: { ctrlTabOrderMode?: CtrlTabOrderMode }) => Promise<void> | void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      title={t('auto.components.settings.RecentTabOrderControl.b5cfdc0198', 'Tab order')}
      description={t(
        'auto.components.settings.RecentTabOrderControl.a867a0889f',
        'Recent or tab strip.'
      )}
      keywords={keywords}
      className="max-w-none"
    >
      <SettingsRow
        label={t('auto.components.settings.RecentTabOrderControl.b5cfdc0198', 'Tab order')}
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
              <SelectItem value="mru">
                {t('auto.components.settings.RecentTabOrderControl.6e6a3fcc61', 'Most recent')}
              </SelectItem>
              <SelectItem value="sequential">
                {t('auto.components.settings.RecentTabOrderControl.3b17c81ede', 'Tab strip order')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
