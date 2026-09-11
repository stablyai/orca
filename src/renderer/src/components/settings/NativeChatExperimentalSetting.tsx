import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { NativeChatSupportedAgents } from './NativeChatSupportedAgents'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'

type NativeChatDefaultView = 'terminal-chat' | 'native-chat'

type NativeChatExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NativeChatExperimentalSetting({
  settings,
  updateSettings
}: NativeChatExperimentalSettingProps): React.JSX.Element {
  const nativeChatEnabled = settings.experimentalNativeChat === true
  const structuredNativeChatEnabled = settings.experimentalStructuredNativeChat === true
  const structuredChatRemoteRead = settings.structuredChatRemoteRead !== false
  const structuredChatRemoteCreate = settings.structuredChatRemoteCreate === true
  const defaultView: NativeChatDefaultView =
    settings.openAgentTabsInChatByDefault === true ? 'native-chat' : 'terminal-chat'

  return (
    <SearchableSetting
      title={translate('auto.components.settings.ExperimentalPane.nativeChat.title', 'Chat UI')}
      description={translate(
        'auto.components.settings.ExperimentalPane.nativeChat.description',
        'Preview the desktop chat surface for supported agent terminal sessions.'
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
              'Enables the experimental Chat UI for newly created supported local sessions. Existing terminal sessions keep the terminal chat path while we tune transcript fidelity, streaming, and parity.'
            )}
          </p>
          <NativeChatSupportedAgents />
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
      {nativeChatEnabled ? (
        <div className="ml-4 space-y-4 border-l border-border pl-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.defaultTitle',
                  'Default view'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.defaultCopy',
                  'Choose how new supported agent terminal tabs open.'
                )}
              </p>
            </div>
            <Select
              value={defaultView}
              onValueChange={(value: NativeChatDefaultView) => {
                updateSettings({
                  openAgentTabsInChatByDefault: value === 'native-chat'
                })
              }}
            >
              <SelectTrigger
                aria-label={translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.defaultViewLabel',
                  'Default Chat UI view'
                )}
                className="w-36"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" sideOffset={4} avoidCollisions={false}>
                <SelectItem value="terminal-chat">
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.defaultViewTerminal',
                    'Terminal chat'
                  )}
                </SelectItem>
                <SelectItem value="native-chat">
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.defaultViewNative',
                    'Chat UI'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Structured chat rides the Chat UI default view; it has no entry path under Terminal
              chat. Hidden only — the opt-in keeps its persisted value for when Chat UI returns. */}
          {defaultView === 'native-chat' ? (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-0.5">
                <Label>
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.structuredTitle',
                    'Use updated structured native chat'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.structuredCopy',
                    'Opt in to the host-owned structured chat runtime for Codex and Claude. Off keeps the existing terminal-backed chat path.'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.structuredScope',
                    'Orca starts these sessions on this machine, and on a paired host once you switch that on below. WSL and SSH execution hosts continue to use terminal chat, and Windows falls back to it unless Orca can read process start times.'
                  )}
                </p>
              </div>
              <SettingsSwitch
                checked={structuredNativeChatEnabled}
                ariaLabel={translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.structuredToggleLabel',
                  'Toggle updated structured native chat'
                )}
                onChange={() =>
                  updateSettings({
                    experimentalStructuredNativeChat: !structuredNativeChatEnabled
                  })
                }
              />
            </div>
          ) : null}

          {defaultView === 'native-chat' && structuredNativeChatEnabled ? (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-0.5">
                <Label>
                  {translate(
                    'components.settings.nativeChat.remoteReadTitle',
                    'Read structured chats on paired hosts'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'components.settings.nativeChat.remoteReadCopy',
                    'Show the structured chats a paired Orca host is running. On its own this only reads them; the switch below is what sends to them.'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'components.settings.nativeChat.remoteReadScope',
                    'Turning this off stops Orca asking each paired host for them from the next time it connects to that host.'
                  )}
                </p>
              </div>
              <SettingsSwitch
                checked={structuredChatRemoteRead}
                ariaLabel={translate(
                  'components.settings.nativeChat.remoteReadToggleLabel',
                  'Toggle reading structured chats on paired hosts'
                )}
                onChange={() =>
                  updateSettings({ structuredChatRemoteRead: !structuredChatRemoteRead })
                }
              />
            </div>
          ) : null}

          {/* Hidden without the read switch: creating on a host whose chats this client refuses to
              show would land the new session somewhere the user cannot see it. */}
          {defaultView === 'native-chat' &&
          structuredNativeChatEnabled &&
          structuredChatRemoteRead ? (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-0.5">
                <Label>
                  {translate(
                    'components.settings.nativeChat.remoteCreateTitle',
                    'Start and send to structured chats on paired hosts'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'components.settings.nativeChat.remoteCreateCopy',
                    'Let new structured chats start on a paired Orca host, and send to the ones already there. The agent runs on that machine, using its files, its tools and its logins.'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'components.settings.nativeChat.remoteCreateScope',
                    'Each host answers for itself, so one may still decline. SSH hosts keep using terminal chat. The in-flight turn and its approvals survive going offline; idle sessions park after about 15 seconds and resume on demand.'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'components.settings.nativeChat.remoteCreateForgeNote',
                    'GitHub and GitLab commands you run stay signed in as you, but an agent in one of these chats runs them on its host — so a host without its own sign-in cannot open pull requests.'
                  )}
                </p>
              </div>
              <SettingsSwitch
                checked={structuredChatRemoteCreate}
                ariaLabel={translate(
                  'components.settings.nativeChat.remoteCreateToggleLabel',
                  'Toggle starting structured chats on paired hosts'
                )}
                onChange={() =>
                  updateSettings({ structuredChatRemoteCreate: !structuredChatRemoteCreate })
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </SearchableSetting>
  )
}
