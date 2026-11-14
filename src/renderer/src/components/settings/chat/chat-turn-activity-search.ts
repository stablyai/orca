import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'
import { NATIVE_CHAT_TURN_DIFF_SETTING_SECTION_ID } from './native-chat-turn-diff-setting-target'
import { NATIVE_CHAT_OPENED_PULL_REQUESTS_SETTING_SECTION_ID } from './native-chat-opened-pull-requests-setting-target'
import { NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID } from './native-chat-ci-result-lines-setting-target'

export const getChatTurnActivityTitle = (t: Translate = translate): string =>
  t('components.settings.nativeChat.turnActivityTitle', 'Turn activity')

export const getChatTurnActivityEntriesByKey = createLocalizedCatalog(
  () =>
    ({
      turnDiffs: {
        targetSectionId: NATIVE_CHAT_TURN_DIFF_SETTING_SECTION_ID,
        title: translate('components.settings.nativeChat.turnDiffsTitle', 'Turn diffs'),
        description: translate(
          'components.settings.nativeChat.turnDiffsCopy',
          'Shows the files each turn changed, with line counts, below the reply.'
        ),
        keywords: [
          translate('components.settings.nativeChat.turnDiffsSearchChangedFiles', 'changed files'),
          translate('components.settings.nativeChat.turnDiffsSearchEdits', 'edits')
        ]
      },
      openedPullRequests: {
        targetSectionId: NATIVE_CHAT_OPENED_PULL_REQUESTS_SETTING_SECTION_ID,
        title: translate(
          'components.settings.nativeChat.openedPullRequestsTitle',
          'Opened pull requests'
        ),
        description: translate(
          'components.settings.nativeChat.openedPullRequestsCopy',
          'Shows the pull requests each turn opened, with titles and line counts, below the reply.'
        ),
        keywords: [
          translate('components.settings.nativeChat.openedPullRequestsSearchPr', 'PR'),
          translate(
            'components.settings.nativeChat.openedPullRequestsSearchCard',
            'pull request card'
          )
        ]
      },
      ciResultLines: {
        targetSectionId: NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID,
        title: translate('components.settings.nativeChat.ciResultLinesTitle', 'CI result lines'),
        description: translate(
          'components.settings.nativeChat.ciResultLinesCopy',
          'A line in the chat when CI finishes on a pull request the agent opened or pushed to.'
        ),
        keywords: [
          translate('components.settings.nativeChat.ciResultLinesSearchChecks', 'checks'),
          translate('components.settings.nativeChat.ciResultLinesSearchPr', 'PR')
        ]
      }
    }) satisfies Record<string, SettingsSearchEntry>
)

export function getChatTurnActivitySearchEntries(t?: Translate): SettingsSearchEntry[] {
  return [
    { title: getChatTurnActivityTitle(t) },
    ...Object.values(getChatTurnActivityEntriesByKey())
  ]
}
