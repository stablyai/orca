import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Card, CardContent } from '../../ui/card'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getChatTransientErrorRecoverySearchEntry } from './chat-transient-error-recovery-search'

export function ChatTransientErrorRecoverySetting({
  settings,
  updateSettings,
  forceVisible = false
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.nativeChatAutoContinueOnTransientError === true
  const entry = getChatTransientErrorRecoverySearchEntry()
  return (
    <SearchableSetting
      {...entry}
      id={entry.targetSectionId}
      forceVisible={forceVisible}
      className="max-w-none"
    >
      <Card>
        <CardContent>
          <SettingsSwitchRow
            label={entry.title}
            description={entry.description}
            checked={enabled}
            ariaLabel={t(
              'components.settings.nativeChat.transientErrorRecoveryToggleLabel',
              'Toggle automatic continuation after temporary errors'
            )}
            onChange={() => updateSettings({ nativeChatAutoContinueOnTransientError: !enabled })}
          />
        </CardContent>
      </Card>
    </SearchableSetting>
  )
}
