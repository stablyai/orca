import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import type { SettingsSearchEntry } from './settings-search'

export function getTaskPromptTemplateSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('components.TaskPromptTemplateSetting.title', 'Task start prompt'),
    description: translate(
      'components.TaskPromptTemplateSetting.description',
      'Customize the draft for a new workspace linked to a task. Use {{url}} for its URL. You review and send the draft yourself.',
      { url: '{{url}}' }
    ),
    keywords: [
      ...translateSearchKeyword('components.TaskPromptTemplateSetting.keywordTemplate', 'template'),
      ...translateSearchKeyword('components.TaskPromptTemplateSetting.keywordSkill', 'skill'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.5430396e11', 'jira'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.412ec3c702', 'linear'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.c10ac2125e', 'github'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.11f001cdd4', 'gitlab')
    ]
  }
}
