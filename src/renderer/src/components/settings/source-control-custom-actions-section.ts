import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const SOURCE_CONTROL_CUSTOM_ACTIONS_SECTION_ID = 'source-control-custom-actions'

export const getSourceControlCustomActionsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('pullRequestCustomActions.settings.title', 'Pull request custom actions'),
    description: translate(
      'pullRequestCustomActions.settings.description',
      'Prompts listed beside Start workspace on a pull request. Choosing one opens the PR workspace and sends the prompt to the agent.'
    ),
    keywords: [
      ...translateSearchKeyword('pullRequestCustomActions.settings.keyword.custom', 'custom'),
      ...translateSearchKeyword('pullRequestCustomActions.settings.keyword.action', 'action'),
      ...translateSearchKeyword('pullRequestCustomActions.settings.keyword.prompt', 'prompt'),
      ...translateSearchKeyword('pullRequestCustomActions.settings.keyword.review', 'review'),
      ...translateSearchKeyword(
        'pullRequestCustomActions.settings.keyword.pullRequest',
        'pull request'
      )
    ]
  }
])
