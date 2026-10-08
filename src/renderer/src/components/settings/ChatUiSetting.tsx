import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { NativeChatShellEnvironmentSetting } from './NativeChatShellEnvironmentSetting'
import { NativeChatQueueFollowUpsSetting } from './NativeChatQueueFollowUpsSetting'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getChatSearchEntry, type ChatSettingRowId } from './chat-search'

type ChatUiSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** The rows Settings indexes: `getChatUiSearchEntries` owns which exist. */
  rows: ReadonlySet<ChatSettingRowId>
  forceVisibleRows?: boolean
}

export function ChatUiSetting({
  settings,
  updateSettings,
  rows,
  forceVisibleRows = false
}: ChatUiSettingProps): React.JSX.Element {
  const nativeChatEnabled = settings.experimentalNativeChat === true
  const resumeOnRestartEnabled = settings.nativeChatResumeWorkOnRestart === true
  const hasNestedRows =
    rows.has('chat-queue-follow-ups') ||
    rows.has('chat-resume-on-restart') ||
    rows.has('chat-shell-environment')

  return (
    <div className="w-full max-w-3xl space-y-3">
      <SearchableSetting {...getChatSearchEntry('chat-ui')} forceVisible className="space-y-3 py-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 shrink space-y-0.5">
            <Label>{translate('auto.components.settings.ChatPane.title', 'Chat UI')}</Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ChatPane.copy',
                'New supported agents open in chat. Unsupported launches use the terminal. Turn this off to open new agents in the terminal; existing chats stay available.'
              )}
            </p>
          </div>
          <SettingsSwitch
            checked={nativeChatEnabled}
            ariaLabel={translate('auto.components.settings.ChatPane.toggleLabel', 'Toggle Chat UI')}
            onChange={() => updateSettings({ experimentalNativeChat: !nativeChatEnabled })}
          />
        </div>
      </SearchableSetting>

      {hasNestedRows ? (
        <div className="ml-4 space-y-4 border-l border-border pl-4">
          {rows.has('chat-queue-follow-ups') ? (
            <SearchableSetting
              {...getChatSearchEntry('chat-queue-follow-ups')}
              forceVisible={forceVisibleRows}
            >
              <NativeChatQueueFollowUpsSetting
                settings={settings}
                updateSettings={updateSettings}
              />
            </SearchableSetting>
          ) : null}
          {rows.has('chat-resume-on-restart') ? (
            <SearchableSetting
              {...getChatSearchEntry('chat-resume-on-restart')}
              forceVisible={forceVisibleRows}
            >
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

          {rows.has('chat-shell-environment') ? (
            <SearchableSetting
              {...getChatSearchEntry('chat-shell-environment')}
              forceVisible={forceVisibleRows}
            >
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
