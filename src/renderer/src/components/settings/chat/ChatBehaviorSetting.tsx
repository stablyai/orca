import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-create-capabilities'
import {
  useChatSettingsOwnPermissions,
  useStructuredAgentSessionHostCapabilityState,
  useStructuredAgentSessionHostQueuesMessages
} from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { useAppStore } from '../../../store/index'
import { Card, CardContent } from '../../ui/card'
import { ChatPermissionSetting } from './ChatPermissionSetting'
import { NativeChatShellEnvironmentSetting } from './NativeChatShellEnvironmentSetting'
import { NativeChatIdleStopSetting } from './NativeChatIdleStopSetting'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { nativeChatQueueFollowUps } from '../../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import { nativeChatScrollsToLatestOnSend } from '../../../../../shared/native-chat/native-chat-appearance-settings'
import { SettingsSubsectionHeader, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getChatBehaviorEntriesByKey, getChatBehaviorTitle } from './chat-behavior-search'
import { getChatPermissionSearchEntry } from './chat-permission-search'
import { matchesSettingsSearch } from '../search/settings-search'

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
  const t = useTranslate()
  const typedPermissions = useChatSettingsOwnPermissions()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const hostQueuesMessages = useStructuredAgentSessionHostQueuesMessages(STRUCTURED_CHAT_HOST)
  const hostContinuesUsageLimits =
    useStructuredAgentSessionHostCapabilityState(
      STRUCTURED_CHAT_HOST,
      AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY
    ) === 'supported'
  const entries = getChatBehaviorEntriesByKey()
  const rows = [
    ...(settings.nativeChatPermissionMode !== undefined
      ? [getChatPermissionSearchEntry(typedPermissions)]
      : []),
    entries.resumeOnRestart,
    entries.idleStop,
    ...(hostContinuesUsageLimits ? [entries.autoContinueAfterUsageLimit] : []),
    ...(hostQueuesMessages ? [entries.queueFollowUps] : []),
    entries.scrollToLatestOnSend,
    entries.linkPreviews,
    entries.shellEnvironment
  ]
  if (!forceVisible && !matchesSettingsSearch(query, rows)) {
    return null
  }
  const resumeOnRestartEnabled = settings.nativeChatResumeWorkOnRestart === true
  const queueFollowUps = nativeChatQueueFollowUps(settings)
  const autoContinueEnabled = settings.nativeChatAutoContinueAfterUsageLimit === true
  const scrollToLatestOnSend = nativeChatScrollsToLatestOnSend(settings)
  const linkPreviewsEnabled = settings.nativeChatLinkPreviews !== false
  return (
    <section id="chat-behavior" className="space-y-3">
      <SettingsSubsectionHeader title={getChatBehaviorTitle(t)} />
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
                ariaLabel={t(
                  'auto.components.settings.ExperimentalPane.nativeChat.resumeToggleLabel',
                  'Toggle automatic resume after a restart'
                )}
                onChange={() =>
                  updateSettings({ nativeChatResumeWorkOnRestart: !resumeOnRestartEnabled })
                }
              />
            </SearchableSetting>
            <SearchableSetting
              {...entries.idleStop}
              id={entries.idleStop.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <NativeChatIdleStopSetting
                settings={settings}
                updateSettings={updateSettings}
                title={entries.idleStop.title}
                description={entries.idleStop.description}
              />
            </SearchableSetting>
            {hostContinuesUsageLimits ? (
              <SearchableSetting
                {...entries.autoContinueAfterUsageLimit}
                id={entries.autoContinueAfterUsageLimit.targetSectionId}
                forceVisible={forceVisible}
                className="max-w-none"
              >
                <SettingsSwitchRow
                  label={entries.autoContinueAfterUsageLimit.title}
                  description={entries.autoContinueAfterUsageLimit.description}
                  checked={autoContinueEnabled}
                  disabled={settings.nativeChatAutoContinueAfterUsageLimit === undefined}
                  ariaLabel={t(
                    'components.settings.nativeChat.usageLimitContinueToggleLabel',
                    'Toggle continuing chats when a usage limit resets'
                  )}
                  onChange={() =>
                    updateSettings({ nativeChatAutoContinueAfterUsageLimit: !autoContinueEnabled })
                  }
                />
              </SearchableSetting>
            ) : null}
            <SearchableSetting
              {...entries.queueFollowUps}
              id={entries.queueFollowUps.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <SettingsSwitchRow
                label={entries.queueFollowUps.title}
                description={entries.queueFollowUps.description}
                checked={queueFollowUps}
                disabled={!hostQueuesMessages}
                ariaLabel={entries.queueFollowUps.title}
                onChange={() => updateSettings({ nativeChatQueueFollowUps: !queueFollowUps })}
              />
            </SearchableSetting>
            <SearchableSetting
              {...entries.scrollToLatestOnSend}
              id={entries.scrollToLatestOnSend.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <SettingsSwitchRow
                label={entries.scrollToLatestOnSend.title}
                description={entries.scrollToLatestOnSend.description}
                checked={scrollToLatestOnSend}
                ariaLabel={entries.scrollToLatestOnSend.title}
                onChange={() =>
                  updateSettings({ nativeChatScrollToLatestOnSend: !scrollToLatestOnSend })
                }
              />
            </SearchableSetting>
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
                ariaLabel={t(
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
