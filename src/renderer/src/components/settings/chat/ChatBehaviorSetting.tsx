import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import {
  useChatSettingsOwnPermissions,
  useStructuredAgentSessionHostCapabilityState,
  useStructuredAgentSessionHostQueuesMessages
} from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { useAppStore } from '../../../store/index'
import { ChatPermissionSetting } from './ChatPermissionSetting'
import { NativeChatShellEnvironmentSetting } from './NativeChatShellEnvironmentSetting'
import { NativeChatIdleStopSetting } from './NativeChatIdleStopSetting'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { nativeChatQueueFollowUps } from '../../../../../shared/native-chat/input/composer/native-chat-follow-up-behavior'
import {
  nativeChatMarksNewMessages,
  nativeChatScrollsToLatestOnSend,
  nativeChatShowsPromptSuggestions
} from '../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { NativeChatUsageLimitContinueSetting } from './NativeChatUsageLimitContinueSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { getChatBehaviorEntriesByKey, getChatBehaviorTitle } from './chat-behavior-search'
import { getChatPermissionSearchEntry } from './chat-permission-search'
import { matchesSettingsSearch } from '../search/settings-search'

// Edit this machine’s runtime; older paired hosts ignore queueing and send follow-ups immediately.
const STRUCTURED_CHAT_HOST: RuntimeClientTarget = { kind: 'local' }

type ChatBehaviorSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** The host picked in Settings; host-run switches read and write it. */
  hostScope: SettingsHostScope
  forceVisible?: boolean
}

export function ChatBehaviorSetting({
  settings,
  updateSettings,
  hostScope,
  forceVisible = false
}: ChatBehaviorSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const typedPermissions = useChatSettingsOwnPermissions()
  const query = useAppStore((state) => state.settingsSearchQuery)
  // A host without the capability ignores the preference; the choice would do nothing.
  const hostQueuesMessages = useStructuredAgentSessionHostQueuesMessages(STRUCTURED_CHAT_HOST)
  const hostContinuesUsageLimits =
    useStructuredAgentSessionHostCapabilityState(
      hostScope.target,
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
    entries.markNewMessages,
    entries.linkPreviews,
    entries.composerSpellcheck,
    entries.promptSuggestions,
    entries.shellEnvironment
  ]
  if (!forceVisible && !matchesSettingsSearch(query, rows)) {
    return null
  }
  const resumeOnRestartEnabled = settings.nativeChatResumeWorkOnRestart === true
  const queueFollowUps = nativeChatQueueFollowUps(settings)
  const scrollToLatestOnSend = nativeChatScrollsToLatestOnSend(settings)
  const markNewMessages = nativeChatMarksNewMessages(settings)
  const linkPreviewsEnabled = settings.nativeChatLinkPreviews !== false
  const composerSpellcheckEnabled = settings.nativeChatComposerSpellcheck !== false
  const promptSuggestions = nativeChatShowsPromptSuggestions(settings)
  return (
    <SettingsGroup id="chat-behavior" title={getChatBehaviorTitle(t)}>
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
          hostScope={hostScope}
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
          <NativeChatUsageLimitContinueSetting
            settings={settings}
            hostScope={hostScope}
            label={entries.autoContinueAfterUsageLimit.title}
            description={entries.autoContinueAfterUsageLimit.description}
          />
        </SearchableSetting>
      ) : null}
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
            checked={queueFollowUps}
            ariaLabel={entries.queueFollowUps.title}
            onChange={() => updateSettings({ nativeChatQueueFollowUps: !queueFollowUps })}
          />
        </SearchableSetting>
      ) : null}
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
          onChange={() => updateSettings({ nativeChatScrollToLatestOnSend: !scrollToLatestOnSend })}
        />
      </SearchableSetting>
      <SearchableSetting
        {...entries.markNewMessages}
        id={entries.markNewMessages.targetSectionId}
        forceVisible={forceVisible}
        className="max-w-none"
      >
        <SettingsSwitchRow
          label={entries.markNewMessages.title}
          description={entries.markNewMessages.description}
          checked={markNewMessages}
          ariaLabel={entries.markNewMessages.title}
          onChange={() => updateSettings({ nativeChatMarkNewMessages: !markNewMessages })}
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
        {...entries.composerSpellcheck}
        id={entries.composerSpellcheck.targetSectionId}
        forceVisible={forceVisible}
        className="max-w-none"
      >
        <SettingsSwitchRow
          label={entries.composerSpellcheck.title}
          description={entries.composerSpellcheck.description}
          checked={composerSpellcheckEnabled}
          ariaLabel={entries.composerSpellcheck.title}
          onChange={() =>
            updateSettings({ nativeChatComposerSpellcheck: !composerSpellcheckEnabled })
          }
        />
      </SearchableSetting>
      <SearchableSetting
        {...entries.promptSuggestions}
        id={entries.promptSuggestions.targetSectionId}
        forceVisible={forceVisible}
        className="max-w-none"
      >
        <SettingsSwitchRow
          label={entries.promptSuggestions.title}
          description={entries.promptSuggestions.description}
          checked={promptSuggestions}
          ariaLabel={entries.promptSuggestions.title}
          onChange={() => updateSettings({ nativeChatPromptSuggestions: !promptSuggestions })}
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
          hostScope={hostScope}
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
