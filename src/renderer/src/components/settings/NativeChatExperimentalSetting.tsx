import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'

type NativeChatExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NativeChatExperimentalSetting({
  settings,
  updateSettings
}: NativeChatExperimentalSettingProps): React.JSX.Element {
  const nativeChatEnabled = settings.experimentalNativeChat === true

  return (
    <SearchableSetting
      title={translate('auto.components.settings.ExperimentalPane.nativeChat.title', 'Chat UI')}
      description={translate(
        'auto.components.settings.ExperimentalPane.nativeChat.description',
        'Open supported new agents in Chat UI.'
      )}
      keywords={getExperimentalSearchEntry().nativeChat.keywords}
      className="space-y-3 py-2"
      id="experimental-native-chat"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate('auto.components.settings.ExperimentalPane.nativeChat.title', 'Chat UI')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.nativeChat.copy',
              'Supported new agents open in structured chat. Other agents open in the terminal; existing chats stay available.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={nativeChatEnabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.nativeChat.toggleLabel',
            'Toggle Chat UI'
          )}
          onChange={() =>
            updateSettings({
              experimentalNativeChat: !nativeChatEnabled
            })
          }
        />
      </div>
    </SearchableSetting>
  )
}
