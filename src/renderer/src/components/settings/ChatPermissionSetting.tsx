import { getChatPermissionSearchEntry } from './chat-permission-search'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  AGENT_CHAT_PERMISSION_MODES,
  agentChatPermissionModeFromSetting
} from '../../../../shared/agent-chat-permission-mode'
import { NativeChatPermissionModePicker } from '../native-chat/NativeChatPermissionModePicker'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'

export function ChatPermissionSetting({
  settings,
  updateSettings,
  forceVisible
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible: boolean
}): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  const entry = getChatPermissionSearchEntry()
  if (
    settings.nativeChatPermissionMode === undefined ||
    (!forceVisible && !matchesSettingsSearch(query, [entry]))
  ) {
    return null
  }
  return (
    <section id="chat-permissions" className="space-y-3">
      <SettingsSubsectionHeader
        title={entry.title}
        description={entry.description}
        action={
          <NativeChatPermissionModePicker
            picker={{
              provider: null,
              current: agentChatPermissionModeFromSetting(settings.nativeChatPermissionMode),
              supported: AGENT_CHAT_PERMISSION_MODES,
              pending: false,
              disabled: false,
              setMode: async (nativeChatPermissionMode) => {
                updateSettings({ nativeChatPermissionMode })
                return true
              }
            }}
          />
        }
      />
    </section>
  )
}
