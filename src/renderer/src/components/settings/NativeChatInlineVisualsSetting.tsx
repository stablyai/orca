import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SettingsSwitchRow } from './SettingsFormControls'
import { Card, CardContent } from '../ui/card'
import { SearchableSetting } from './SearchableSetting'
import { getChatInlineVisualsSearchEntry } from './chat-inline-visuals-search'

type NativeChatInlineVisualsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}

export function NativeChatInlineVisualsSetting({
  settings,
  updateSettings,
  forceVisible = false
}: NativeChatInlineVisualsSettingProps): React.JSX.Element {
  const enabled = settings.nativeChatInlineVisuals !== false
  const entry = getChatInlineVisualsSearchEntry()
  return (
    <SearchableSetting
      {...entry}
      id="chat-inline-visuals"
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
              'components.settings.nativeChat.inlineVisualsToggleLabel',
              'Toggle inline visuals'
            )}
            onChange={() => updateSettings({ nativeChatInlineVisuals: !enabled })}
          />
        </CardContent>
      </Card>
    </SearchableSetting>
  )
}
