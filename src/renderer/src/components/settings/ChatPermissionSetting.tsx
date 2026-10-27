import { useChatPermissionSettings } from './use-chat-permission-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  AGENT_CHAT_PERMISSION_MODES,
  agentChatPermissionModes,
  newChatPermissionModeForSettings
} from '../../../../shared/agent-chat-permission-mode'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { PERMISSION_CHOICE_AGENTS } from '../../../../shared/tui-agent-permission-choice'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { NativeChatPermissionModePicker } from '../native-chat/NativeChatPermissionModePicker'
import { nativeChatPermissionModeLabel } from '../native-chat/native-chat-permission-mode-labels'
import { SettingsRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getChatPermissionSearchEntry } from './chat-permission-search'
import { translate } from '@/i18n/i18n'

/** The host seeds every chat from its agent's one stored permission. */
export function ChatPermissionSetting({
  settings,
  updateSettings,
  forceVisible
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible: boolean
}): React.JSX.Element | null {
  const { capability, settings: permissionSettings } = useChatPermissionSettings(settings)
  const supported = capability === 'supported'
  const modern = capability !== 'unsupported'
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  if (settings.nativeChatPermissionMode === undefined) {
    return null
  }
  const entry = getChatPermissionSearchEntry(supported)
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
          modern ? (
            <Button
              variant="link"
              size="xs"
              disabled={!supported}
              onClick={() => openSettingsTarget({ pane: 'agents', repoId: null })}
            >
              {translate('settings.chat.permissionsAgentsLink', 'Settings → Agents')}
            </Button>
          ) : (
            <NativeChatPermissionModePicker
              current={settings.nativeChatPermissionMode}
              modes={AGENT_CHAT_PERMISSION_MODES}
              onSelect={(mode) => updateSettings({ nativeChatPermissionMode: mode })}
            />
          )
        }
      />
      {modern
        ? PERMISSION_CHOICE_AGENTS.filter((agent) => agentChatPermissionModes(agent)).map(
            (agent) => {
              const mode = newChatPermissionModeForSettings(agent, permissionSettings)
              const label =
                mode === 'own'
                  ? translate('settings.agents.permissionOwnShort', 'Own settings')
                  : mode
                    ? nativeChatPermissionModeLabel(mode)
                    : ''
              return (
                <SettingsRow
                  key={agent}
                  label={TUI_AGENT_DISPLAY_NAMES[agent]}
                  control={
                    <span className="text-xs text-muted-foreground">
                      {supported && permissionSettings ? label : '—'}
                    </span>
                  }
                />
              )
            }
          )
        : null}
    </SearchableSetting>
  )
}
