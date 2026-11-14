import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

export function TabBarOrderControl({
  value,
  keywords,
  updateSettings
}: {
  value: NonNullable<GlobalSettings['tabBarOrderMode']>
  keywords?: string[]
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('settings.general.tabBarOrder.title', 'Tab bar order')
  const description = t(
    'settings.general.tabBarOrder.description',
    'Move unpinned tabs to the front when typing or switching with the keyboard. Clicking keeps tabs in place. Dragged tabs stay until the next interaction.'
  )
  return (
    <SearchableSetting title={title} description={description} keywords={keywords}>
      <SettingsRow
        label={title}
        description={description}
        control={
          <Select
            value={value}
            onValueChange={(mode) =>
              void updateSettings({ tabBarOrderMode: mode === 'mru' ? 'mru' : 'manual' })
            }
          >
            <SelectTrigger className="w-[180px]" aria-label={title}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">
                {t('settings.general.tabBarOrder.manual', 'Manual')}
              </SelectItem>
              <SelectItem value="mru">
                {t('settings.general.tabBarOrder.mru', 'Most recently used')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
