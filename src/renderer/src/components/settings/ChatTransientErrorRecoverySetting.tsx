import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Card, CardContent } from '../ui/card'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
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
            ariaLabel={translate(
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
