import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { NativeChatShellEnvironmentSetting } from './NativeChatShellEnvironmentSetting'
import { NativeChatSupportedAgents } from './NativeChatSupportedAgents'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getChatSearchEntry } from './chat-search'

type NativeChatDefaultView = 'terminal-chat' | 'native-chat'

type ChatPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function ChatPane({ settings, updateSettings }: ChatPaneProps): React.JSX.Element {
  const nativeChatEnabled = settings.experimentalNativeChat === true
  const resumeOnRestartEnabled = settings.nativeChatResumeWorkOnRestart === true
  const defaultView: NativeChatDefaultView =
    settings.openAgentTabsInChatByDefault === true ? 'native-chat' : 'terminal-chat'
  // They apply to every open Chat UI chat whatever the default view, but web clients cannot reach the host copy.
  const showHostOwnedRows = !isPairedWebClientWindow()

  return (
    <div className="w-full max-w-3xl space-y-3">
      {/* Every other row depends on this switch, so a search that lands here must keep it reachable. */}
      <SearchableSetting {...getChatSearchEntry('chat-ui')} forceVisible className="space-y-3 py-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 shrink space-y-0.5">
            <Label>{translate('auto.components.settings.ChatPane.title', 'Chat UI')}</Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ChatPane.copy',
                'Adds a chat view to supported agent sessions. Switch between chat and terminal from the agent pane.'
              )}
            </p>
            <NativeChatSupportedAgents />
          </div>
          <SettingsSwitch
            checked={nativeChatEnabled}
            ariaLabel={translate('auto.components.settings.ChatPane.toggleLabel', 'Toggle Chat UI')}
            onChange={() => updateSettings({ experimentalNativeChat: !nativeChatEnabled })}
          />
        </div>
      </SearchableSetting>

      {nativeChatEnabled ? (
        <div className="ml-4 space-y-4 border-l border-border pl-4">
          <SearchableSetting {...getChatSearchEntry('chat-default-view')}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-0.5">
                <Label>
                  {translate('auto.components.settings.ChatPane.defaultTitle', 'Default view')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.ChatPane.defaultCopy',
                    'Choose how new supported agent terminal tabs open.'
                  )}
                </p>
                {defaultView === 'native-chat' ? (
                  <p className="text-xs text-muted-foreground">
                    {translate(
                      'auto.components.settings.ChatPane.structuredScopeLocalOnly',
                      'Local sessions only for now. WSL and remote execution hosts (including SSH) continue to use terminal chat.'
                    )}
                  </p>
                ) : null}
              </div>
              <Select
                value={defaultView}
                onValueChange={(value: NativeChatDefaultView) => {
                  updateSettings({ openAgentTabsInChatByDefault: value === 'native-chat' })
                }}
              >
                <SelectTrigger
                  aria-label={translate(
                    'auto.components.settings.ChatPane.defaultViewLabel',
                    'Default Chat UI view'
                  )}
                  className="w-36"
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  side="bottom"
                  sideOffset={4}
                  avoidCollisions={false}
                >
                  <SelectItem value="terminal-chat">
                    {translate(
                      'auto.components.settings.ChatPane.defaultViewTerminal',
                      'Terminal chat'
                    )}
                  </SelectItem>
                  <SelectItem value="native-chat">
                    {translate('auto.components.settings.ChatPane.defaultViewNative', 'Chat UI')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SearchableSetting>

          {showHostOwnedRows ? (
            <SearchableSetting {...getChatSearchEntry('chat-resume-on-restart')}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 shrink space-y-0.5">
                  <Label>
                    {translate(
                      'auto.components.settings.ChatPane.resumeTitle',
                      'Resume working chats automatically after a restart'
                    )}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {translate(
                      'auto.components.settings.ChatPane.resumeCopy',
                      'When Orca quits or installs an update, chats that were working are automatically resumed when Orca is reopened.'
                    )}
                  </p>
                </div>
                <SettingsSwitch
                  checked={resumeOnRestartEnabled}
                  ariaLabel={translate(
                    'auto.components.settings.ChatPane.resumeToggleLabel',
                    'Toggle automatic resume after a restart'
                  )}
                  onChange={() =>
                    updateSettings({ nativeChatResumeWorkOnRestart: !resumeOnRestartEnabled })
                  }
                />
              </div>
            </SearchableSetting>
          ) : null}

          {showHostOwnedRows ? (
            <SearchableSetting {...getChatSearchEntry('chat-shell-environment')}>
              <NativeChatShellEnvironmentSetting
                settings={settings}
                updateSettings={updateSettings}
              />
            </SearchableSetting>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
