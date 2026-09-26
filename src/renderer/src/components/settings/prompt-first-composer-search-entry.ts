import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getPromptFirstComposerSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.promptFirstComposer.title',
      'Prompt-first worktree creation'
    ),
    description: translate(
      'auto.components.settings.experimental.search.promptFirstComposer.description',
      'Open Create worktree on a chat-style prompt box with project, host and agent as compact pills.'
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
        'auto.components.settings.experimental.search.promptFirstComposer.composer',
        'composer'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.promptFirstComposer.worktree',
        'worktree'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.promptFirstComposer.create',
        'create'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.promptFirstComposer.chat',
        'chat'
      )
    ]
  }
}
