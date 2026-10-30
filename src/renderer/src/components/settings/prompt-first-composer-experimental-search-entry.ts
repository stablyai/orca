import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getPromptFirstComposerSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.promptFirstComposer.title',
      'Start new workspaces from a prompt'
    ),
    description: translate(
      'auto.components.settings.experimental.search.promptFirstComposer.description',
      'New workspace opens on a prompt box. Creating the workspace sends the prompt to the selected agent as its first message.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.promptFirstComposer.prompt',
        'prompt'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.promptFirstComposer.worktree',
        'worktree'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.promptFirstComposer.composer',
        'composer'
      )
    ]
  }
}
