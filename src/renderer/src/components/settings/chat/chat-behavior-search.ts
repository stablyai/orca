import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import type { Translate } from '@/i18n/use-translate'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'
import { NATIVE_CHAT_RESUME_SETTING_SECTION_ID } from './native-chat-resume-setting-target'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_SETTING_SECTION_ID } from './native-chat-usage-limit-continue-setting-target'

export const getChatBehaviorTitle = (t: Translate = translate): string =>
  t('components.settings.nativeChat.behaviorTitle', 'Behavior')

export const getChatBehaviorEntriesByKey = createLocalizedCatalog(() => ({
  sideChatPane: {
    targetSectionId: 'chat-side-chat-pane',
    title: translate(
      'components.native-chat.currentSideChat.pane',
      'Group side chats in a separate pane'
    ),
    keywords: [translate('components.native-chat.currentSideChat.mark', 'btw')]
  },
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
      ...translateSearchKeyword('components.settings.nativeChat.resumeSearchUpdate', 'update'),
      ...translateSearchKeyword('components.settings.nativeChat.resumeSearchRelaunch', 'relaunch')
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
      ...translateSearchKeyword(
        'components.settings.nativeChat.usageLimitContinueSearchLimit',
        'usage limit'
      ),
      ...translateSearchKeyword(
        'components.settings.nativeChat.usageLimitContinueSearchReset',
        'reset'
      )
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
      ...translateSearchKeyword('components.settings.nativeChat.idleStopSearchIdle', 'idle'),
      ...translateSearchKeyword('components.settings.nativeChat.idleStopSearchTimeout', 'timeout'),
      ...translateSearchKeyword(
        'components.settings.nativeChat.idleStopSearchKeepAlive',
        'keep alive'
      )
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
      ...translateSearchKeyword('components.settings.nativeChat.queueSearchQueue', 'queue'),
      ...translateSearchKeyword('components.settings.nativeChat.queueSearchSteer', 'steer')
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
      ...translateSearchKeyword(
        'components.settings.nativeChat.scrollToLatestOnSendSearchPosition',
        'position'
      )
    ]
  },
  markNewMessages: {
    targetSectionId: 'chat-mark-new-messages',
    title: translate(
      'components.settings.nativeChat.markNewMessagesTitle',
      'Mark new messages when returning to a chat'
    ),
    description: translate(
      'components.settings.nativeChat.markNewMessagesCopy',
      'Coming back to a chat draws a New line above what arrived while you were away, and scrolls to it if you were reading the latest.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'components.settings.nativeChat.markNewMessagesSearchUnread',
        'unread'
      )
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
      ...translateSearchKeyword(
        'components.settings.nativeChat.linkPreviewsSearchUnfurl',
        'unfurl'
      ),
      ...translateSearchKeyword(
        'components.settings.nativeChat.linkPreviewsSearchHover',
        'hover card'
      )
    ]
  },
  composerSpellcheck: {
    targetSectionId: 'chat-composer-spellcheck',
    title: translate(
      'components.settings.nativeChat.composerSpellcheckTitle',
      'Spellcheck and autocorrect'
    ),
    description: translate(
      'components.settings.nativeChat.composerSpellcheckCopy',
      'Underlines misspelled words and applies system text replacements in the message box. Turn off to stop both here without changing them system-wide.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'components.settings.nativeChat.composerSpellcheckSearchSpelling',
        'spellcheck'
      ),
      ...translateSearchKeyword(
        'components.settings.nativeChat.composerSpellcheckSearchAutocorrect',
        'autocorrect'
      )
    ]
  },
  promptSuggestions: {
    targetSectionId: 'chat-prompt-suggestions',
    title: translate('components.settings.nativeChat.promptSuggestionsTitle', 'Suggested prompts'),
    description: translate(
      'components.settings.nativeChat.promptSuggestionsCopy',
      'After Claude replies, its guess at your next message shows in the empty message box. Press Tab to use it. Each guess is an extra request that counts toward your Claude usage.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'components.settings.nativeChat.promptSuggestionsSearchNext',
        'next prompt'
      ),
      ...translateSearchKeyword(
        'components.settings.nativeChat.promptSuggestionsSearchGhost',
        'ghost text'
      ),
      // Russian wording for both the old «промпт» and the glossary «запрос» spellings; users search either.
      'Предлагаемые промпты',
      'следующий промпт',
      'следующий запрос'
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
      ...translateSearchKeyword(
        'components.settings.nativeChat.shellEnvSearchVariables',
        'environment variables'
      ),
      ...translateSearchKeyword('components.settings.nativeChat.shellEnvSearchPath', 'PATH'),
      ...translateSearchKeyword('components.settings.nativeChat.shellEnvSearchProxy', 'proxy')
    ]
  }
}))

export function getChatBehaviorSearchEntries(t?: Translate): SettingsSearchEntry[] {
  return [{ title: getChatBehaviorTitle(t) }, ...Object.values(getChatBehaviorEntriesByKey())]
}
