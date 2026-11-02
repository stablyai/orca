import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../../shared/agent-chat-permission-mode'
import { NativeChatPermissionModePicker } from '../native-chat/NativeChatPermissionModePicker'
import { SettingsRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getChatPermissionSearchEntry } from './chat-permission-search'

/** This host's mode for new chats; each chat keeps its own once created. */
export function ChatPermissionSetting({
  settings,
  updateSettings,
  forceVisible
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible: boolean
}): React.JSX.Element | null {
  const current = settings.nativeChatPermissionMode
  if (current === undefined) {
    return null
  }
  const entry = getChatPermissionSearchEntry()
  return (
    <SearchableSetting
      {...entry}
      id="chat-permissions"
      forceVisible={forceVisible}
      className="max-w-none"
    >
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <NativeChatPermissionModePicker
            current={current}
            modes={AGENT_CHAT_PERMISSION_MODES}
            onSelect={(nativeChatPermissionMode) => updateSettings({ nativeChatPermissionMode })}
          />
        }
      />
    </SearchableSetting>
  )
}
