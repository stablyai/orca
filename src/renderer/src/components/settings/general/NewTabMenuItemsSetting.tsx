import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  isNewTabMenuItemHidden,
  setNewTabMenuItemHidden,
  type NewTabMenuHideableItem
} from '../../../../../shared/new-tab-menu-items'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

export function NewTabMenuItemsSetting({
  hiddenItems,
  updateSettings
}: {
  hiddenItems: GlobalSettings['newTabMenuHiddenItems']
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const rows: { item: NewTabMenuHideableItem; label: string; description?: string }[] = [
    { item: 'browser', label: t('auto.components.tab.bar.TabBar.4833fb2cbe', 'New Browser Tab') },
    {
      item: 'new-markdown',
      label: t('auto.components.tab.bar.TabBar.3d5d6c960d', 'New Markdown'),
      description: t(
        'settings.general.newTabMenu.newMarkdownDescription',
        'Also covers file types added by plugins.'
      )
    },
    {
      item: 'open-markdown',
      label: t('auto.components.tab.bar.TabBar.4f327c8b3d', 'Open Markdown...')
    },
    {
      item: 'mobile-emulator',
      label: t('settings.general.newTabMenu.mobileEmulator', 'Mobile Emulator')
    }
  ]
  return (
    <SettingsGroup
      title={t('settings.general.newTabMenu.title', 'New Tab Menu')}
      description={t(
        'settings.general.newTabMenu.groupDescription',
        'Choose which items the + button next to your tabs offers. New Terminal and agents always appear.'
      )}
    >
      {rows.map(({ item, label, description }) => {
        const shown = !isNewTabMenuItemHidden(hiddenItems, item)
        return (
          <SettingsSwitchRow
            key={item}
            label={label}
            description={description}
            checked={shown}
            onChange={() =>
              updateSettings({
                newTabMenuHiddenItems: setNewTabMenuItemHidden(hiddenItems, item, shown)
              })
            }
          />
        )
      })}
    </SettingsGroup>
  )
}
