import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getChatErrorEscalationDescription,
  getChatErrorEscalationTitle
} from './chat-error-escalation-copy'

type OrchestrationChatErrorSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationChatErrorSetting({
  settings,
  updateSettings
}: OrchestrationChatErrorSettingProps): React.JSX.Element {
  const nativeChatEnabled = settings.experimentalNativeChat === true
  const escalationEnabled = settings.orchestrationChatErrorEscalationEnabled !== false
  const needsChat = nativeChatEnabled
    ? ''
    : ` ${translate(
        'auto.components.settings.OrchestrationPane.chatErrorEscalationNeedsChat',
        'Turn on Chat UI in Experimental settings to use it.'
      )}`
  return (
    <SettingsSwitchRow
      label={getChatErrorEscalationTitle()}
      description={`${getChatErrorEscalationDescription()}${needsChat}`}
      // Off while Chat UI is off: no agent can be a chat worker, so the switch could do nothing.
      checked={nativeChatEnabled && escalationEnabled}
      disabled={!nativeChatEnabled}
      ariaLabel={getChatErrorEscalationTitle()}
      onChange={() => {
        void updateSettings({ orchestrationChatErrorEscalationEnabled: !escalationEnabled })
      }}
    />
  )
}
