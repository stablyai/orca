import { useTranslate } from '@/i18n/use-translate'
import {
  normalizeTimeFormatPreference,
  type TimeFormatPreference
} from '../../../../../shared/i18n/time-format-preference'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getTimeFormatEntries } from './appearance-time-format-search'

type AppearanceTimeFormatSettingProps = {
  timeFormat: unknown
  forceVisible: boolean
  onChange: (timeFormat: TimeFormatPreference) => void
}

export function AppearanceTimeFormatSetting({
  timeFormat,
  forceVisible,
  onChange
}: AppearanceTimeFormatSettingProps): React.JSX.Element {
  const t = useTranslate()
  const entry = getTimeFormatEntries()[0]
  const title = t('settings.appearance.timeFormat.title', 'Time format')
  return (
    <SearchableSetting
      title={title}
      description={entry?.description}
      keywords={entry?.keywords ?? ['time', 'clock', '24-hour', '12-hour']}
      forceVisible={forceVisible}
    >
      <SettingsRow
        label={title}
        control={
          <Select
            value={normalizeTimeFormatPreference(timeFormat)}
            onValueChange={(value) => onChange(normalizeTimeFormatPreference(value))}
          >
            <SelectTrigger size="sm" className="w-[140px]" aria-label={title}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                {t('settings.appearance.timeFormat.system', 'System')}
              </SelectItem>
              <SelectItem value="24h">
                {t('settings.appearance.timeFormat.24h', '24-hour')}
              </SelectItem>
              <SelectItem value="12h">
                {t('settings.appearance.timeFormat.12h', '12-hour')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
