import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useLocalStructuredAgentSessionsHeld } from '@/runtime/local-structured-chats'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { NativeChatQueueFollowUpsSetting } from './NativeChatQueueFollowUpsSetting'
import { NativeChatShellEnvironmentSetting } from './NativeChatShellEnvironmentSetting'
import { NativeChatSupportedAgents } from './NativeChatSupportedAgents'
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
  const resumeOnRestartEnabled = settings.nativeChatResumeWorkOnRestart === true
  const holdsStructuredChats = useLocalStructuredAgentSessionsHeld()
  const structuredChatActive = nativeChatEnabled || holdsStructuredChats

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
      {structuredChatActive ? (
        <div className="ml-4 space-y-4 border-l border-border pl-4">
          {/* Only structured sessions have a resume cursor to continue from. */}
          {structuredChatActive ? (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-0.5">
                <Label>
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.resumeTitle',
                    'Resume working chats automatically after a restart'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.resumeCopy',
                    'When Orca quits or installs an update, chats that were working are automatically resumed when Orca is reopened.'
                  )}
                </p>
              </div>
              <SettingsSwitch
                checked={resumeOnRestartEnabled}
                ariaLabel={translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.resumeToggleLabel',
                  'Toggle automatic resume after a restart'
                )}
                onChange={() =>
                  updateSettings({ nativeChatResumeWorkOnRestart: !resumeOnRestartEnabled })
                }
              />
            </div>
          ) : null}

          {structuredChatActive ? (
            <NativeChatQueueFollowUpsSetting settings={settings} updateSettings={updateSettings} />
          ) : null}

          {structuredChatActive ? (
            <NativeChatShellEnvironmentSetting
              settings={settings}
              updateSettings={updateSettings}
            />
          ) : null}
        </div>
      ) : null}
    </SearchableSetting>
  )
}
