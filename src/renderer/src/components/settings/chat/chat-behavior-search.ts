import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'
import { NATIVE_CHAT_RESUME_SETTING_SECTION_ID } from './native-chat-resume-setting-target'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_SETTING_SECTION_ID } from './native-chat-usage-limit-continue-setting-target'
import { NATIVE_CHAT_OPENED_PULL_REQUESTS_SETTING_SECTION_ID } from './native-chat-opened-pull-requests-setting-target'

export const getChatBehaviorTitle = (): string =>
  translate('components.settings.nativeChat.behaviorTitle', 'Behavior')

export const getChatBehaviorEntriesByKey = createLocalizedCatalog(() => ({
  resumeOnRestart: {
    targetSectionId: NATIVE_CHAT_RESUME_SETTING_SECTION_ID,
    title: translate(
      'auto.components.settings.ExperimentalPane.nativeChat.resumeTitle',
      'Resume working chats automatically after a restart'
    ),
    description: translate(
      'auto.components.settings.ExperimentalPane.nativeChat.resumeCopy',
      'When Orca quits or installs an update, chats that were working are automatically resumed when Orca is reopened.'
    ),
    keywords: [
      translate('components.settings.nativeChat.resumeSearchUpdate', 'update'),
      translate('components.settings.nativeChat.resumeSearchRelaunch', 'relaunch')
    ]
  },
  autoContinueAfterUsageLimit: {
    targetSectionId: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_SETTING_SECTION_ID,
    title: translate(
      'components.settings.nativeChat.usageLimitContinueTitle',
      'Continue chats automatically when a usage limit resets'
    ),
    description: translate(
      'components.settings.nativeChat.usageLimitContinueCopy',
      'Orca sends "Continue where you left off." when the limit resets. Applies to all chats with a known reset time.'
    ),
    keywords: [
      translate('components.settings.nativeChat.usageLimitContinueSearchLimit', 'usage limit'),
      translate('components.settings.nativeChat.usageLimitContinueSearchReset', 'reset')
    ]
  },
  idleStop: {
    targetSectionId: 'chat-idle-stop',
    title: translate('components.settings.nativeChat.idleStopTitle', 'Stop idle agents after'),
    description: translate(
      'components.settings.nativeChat.idleStopCopy',
      "Ends a chat's agent once the chat has been idle this long, to free memory. The chat stays, and your next message starts the agent again. Choose Never for agents that keep working in the background between turns."
    ),
    keywords: [
      translate('components.settings.nativeChat.idleStopSearchIdle', 'idle'),
      translate('components.settings.nativeChat.idleStopSearchTimeout', 'timeout'),
      translate('components.settings.nativeChat.idleStopSearchKeepAlive', 'keep alive')
    ]
  },
  queueFollowUps: {
    targetSectionId: 'chat-queue-follow-ups',
    title: translate('components.settings.nativeChat.followUpBehaviorTitle', 'Queue follow-ups'),
    description: translate(
      'components.settings.nativeChat.followUpBehaviorCopy',
      'Messages sent while the agent works wait as cards until the turn ends, instead of going into the running turn. Cmd/Ctrl+Enter does the opposite for one message, and with nothing typed steers the first waiting card into the running turn. Messages with images wait as cards too.'
    ),
    keywords: [
      translate('components.settings.nativeChat.queueSearchQueue', 'queue'),
      translate('components.settings.nativeChat.queueSearchSteer', 'steer')
    ]
  },
  scrollToLatestOnSend: {
    targetSectionId: 'chat-scroll-to-latest-on-send',
    title: translate(
      'components.settings.nativeChat.scrollToLatestOnSendTitle',
      'Scroll to latest when sending'
    ),
    description: translate(
      'components.settings.nativeChat.scrollToLatestOnSendCopy',
      'Sending while scrolled up jumps to the latest message and follows the reply. Turn off to keep your place.'
    ),
    keywords: [
      translate('components.settings.nativeChat.scrollToLatestOnSendSearchPosition', 'position')
    ]
  },
  linkPreviews: {
    targetSectionId: 'chat-link-previews',
    title: translate('components.settings.nativeChat.linkPreviewsTitle', 'Link previews'),
    description: translate(
      'components.settings.nativeChat.linkPreviewsCopy',
      'Hovering a web link shows a preview card. Orca fetches the page to build it, so the site can see the request.'
    ),
    keywords: [
      translate('components.settings.nativeChat.linkPreviewsSearchUnfurl', 'unfurl'),
      translate('components.settings.nativeChat.linkPreviewsSearchHover', 'hover card')
    ]
  },
  openedPullRequests: {
    targetSectionId: NATIVE_CHAT_OPENED_PULL_REQUESTS_SETTING_SECTION_ID,
    title: translate(
      'components.settings.nativeChat.openedPullRequestsTitle',
      'Show pull requests the agent opens'
    ),
    description: translate(
      'components.settings.nativeChat.openedPullRequestsCopy',
      'A card under the turn that opened a pull request, with its title and changed lines.'
    ),
    keywords: [
      translate('components.settings.nativeChat.openedPullRequestsSearchPr', 'PR'),
      translate('components.settings.nativeChat.openedPullRequestsSearchCard', 'pull request card')
    ]
  },
  shellEnvironment: {
    targetSectionId: 'chat-shell-environment',
    title: translate(
      'auto.components.settings.ExperimentalPane.nativeChat.shellEnvTitle',
      'Use your shell environment'
    ),
    description: translate(
      'auto.components.settings.ExperimentalPane.nativeChat.shellEnvCopy',
      'Codex and Claude chats start with every variable your login shell exports, the same as a terminal. Turn off to choose which ones they get.'
    ),
    keywords: [
      translate('components.settings.nativeChat.shellEnvSearchVariables', 'environment variables'),
      translate('components.settings.nativeChat.shellEnvSearchPath', 'PATH'),
      translate('components.settings.nativeChat.shellEnvSearchProxy', 'proxy')
    ]
  }
}))

export function getChatBehaviorSearchEntries(): SettingsSearchEntry[] {
  return [{ title: getChatBehaviorTitle() }, ...Object.values(getChatBehaviorEntriesByKey())]
}
