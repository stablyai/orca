import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getShareSkillsSettingsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.shareSkills.linkTitle', 'Unlisted skill links'),
    description: translate(
      'auto.components.settings.shareSkills.searchDescription',
      'Share your skills with an unlisted link. Anyone who has it can install them.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.shareSkills.keywordSkills', 'skills'),
      ...translateSearchKeyword('auto.components.settings.shareSkills.keywordShare', 'share'),
      ...translateSearchKeyword('auto.components.settings.shareSkills.keywordBundle', 'bundle'),
      ...translateSearchKeyword('auto.components.settings.shareSkills.keywordLink', 'link'),
      ...translateSearchKeyword('auto.components.settings.shareSkills.keywordUnlisted', 'unlisted'),
      ...translateSearchKeyword('auto.components.settings.shareSkills.keywordRevoke', 'revoke')
    ]
  }
])
