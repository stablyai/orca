import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  useChatSettingsOwnPermissions,
  useStructuredAgentSessionHostQueuesMessages
} from '@/runtime/structured-agent-session-host-capability'
import { useAppStore } from '../../store'
import { Card, CardContent } from '../ui/card'
import { ChatPermissionSetting } from './ChatPermissionSetting'
import { NativeChatShellEnvironmentSetting } from './NativeChatShellEnvironmentSetting'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { getChatBehaviorEntriesByKey, getChatBehaviorTitle } from './chat-behavior-search'
import { getChatPermissionSearchEntry } from './chat-permission-search'
import { matchesSettingsSearch } from './settings-search'

// Edit this machine’s runtime; older paired hosts ignore queueing and send follow-ups immediately.
const STRUCTURED_CHAT_HOST: RuntimeClientTarget = { kind: 'local' }

type ChatBehaviorSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}

export function ChatBehaviorSetting({
  settings,
  updateSettings,
  forceVisible = false
}: ChatBehaviorSettingProps): React.JSX.Element | null {
  const typedPermissions = useChatSettingsOwnPermissions()
  const query = useAppStore((state) => state.settingsSearchQuery)
  // A host without the capability ignores the preference; the switch would do nothing.
  const hostQueuesMessages = useStructuredAgentSessionHostQueuesMessages(STRUCTURED_CHAT_HOST)
  const entries = getChatBehaviorEntriesByKey()
  const rows = [
    ...(settings.nativeChatPermissionMode !== undefined
      ? [getChatPermissionSearchEntry(typedPermissions)]
      : []),
    entries.resumeOnRestart,
    ...(hostQueuesMessages ? [entries.queueFollowUps] : []),
    entries.linkPreviews,
    entries.shellEnvironment
  ]
  if (!forceVisible && !matchesSettingsSearch(query, rows)) {
    return null
  }
  const resumeOnRestartEnabled = settings.nativeChatResumeWorkOnRestart === true
  const queueFollowUpsEnabled = settings.nativeChatQueueFollowUps !== false
  const linkPreviewsEnabled = settings.nativeChatLinkPreviews !== false
  return (
    <section id="chat-behavior" className="space-y-3">
      <SettingsSubsectionHeader title={getChatBehaviorTitle()} />
      <Card>
        <CardContent>
          <div className="divide-y divide-border/40">
            <ChatPermissionSetting
              settings={settings}
              updateSettings={updateSettings}
              forceVisible={forceVisible}
            />
            <SearchableSetting
              {...entries.resumeOnRestart}
              id={entries.resumeOnRestart.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <SettingsSwitchRow
                label={entries.resumeOnRestart.title}
                description={entries.resumeOnRestart.description}
                checked={resumeOnRestartEnabled}
                ariaLabel={translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.resumeToggleLabel',
                  'Toggle automatic resume after a restart'
                )}
                onChange={() =>
                  updateSettings({ nativeChatResumeWorkOnRestart: !resumeOnRestartEnabled })
                }
              />
            </SearchableSetting>
            {hostQueuesMessages ? (
              <SearchableSetting
                {...entries.queueFollowUps}
                id={entries.queueFollowUps.targetSectionId}
                forceVisible={forceVisible}
                className="max-w-none"
              >
                <SettingsSwitchRow
                  label={entries.queueFollowUps.title}
                  description={entries.queueFollowUps.description}
                  checked={queueFollowUpsEnabled}
                  ariaLabel={translate(
                    'components.settings.nativeChat.queueFollowUpsToggleLabel',
                    'Toggle queue follow-ups'
                  )}
                  onChange={() =>
                    updateSettings({ nativeChatQueueFollowUps: !queueFollowUpsEnabled })
                  }
                />
              </SearchableSetting>
            ) : null}
            <SearchableSetting
              {...entries.linkPreviews}
              id={entries.linkPreviews.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <SettingsSwitchRow
                label={entries.linkPreviews.title}
                description={entries.linkPreviews.description}
                checked={linkPreviewsEnabled}
                ariaLabel={translate(
                  'components.settings.nativeChat.linkPreviewsToggleLabel',
                  'Toggle link previews'
                )}
                onChange={() => updateSettings({ nativeChatLinkPreviews: !linkPreviewsEnabled })}
              />
            </SearchableSetting>
            <SearchableSetting
              {...entries.shellEnvironment}
              id={entries.shellEnvironment.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <NativeChatShellEnvironmentSetting
                settings={settings}
                updateSettings={updateSettings}
              />
            </SearchableSetting>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
