import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getCommitMessageAiPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.commit.message.ai.search.24dbdfca78',
      'Show Source Control AI actions'
    ),
    description: translate(
      'auto.components.settings.commit.message.ai.search.0b946b2abe',
      'Adds action recipes for Source Control commit, pull request, branch-name, and fix actions.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.c33cb1b982',
        'ai'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.127d512e75',
        'commit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.93e5210da8',
        'message'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.8e9cc598d7',
        'generate'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.3766941527',
        'agent'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.f121bec167',
        'claude'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.542e1a00a7',
        'codex'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.82109d627d',
        'source control'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.ee14a9e9f7',
        'enabled'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.commit.message.ai.search.3c4e5e5938',
      'Action recipes'
    ),
    description: translate(
      'auto.components.settings.commit.message.ai.search.18b6d38835',
      'Agent, CLI arguments, and command template used by each Source Control AI button.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.3766941527',
        'agent'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.0f29331fed',
        'arguments'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.61117e57f3',
        'args'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.57c851a68c',
        'cli'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.f4731b22bf',
        'command'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.8e0bcc5d99',
        'model'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.b7d50da4d8',
        'template'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.402f101af8',
        'prompt'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.37c65bbb44',
        'fix'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.c46e665f7e',
        'checks'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.53e8504fb2',
        'ci'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.d22a6459e4',
        'conflicts'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.127d512e75',
        'commit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.110be48b81',
        'pull request'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.d32936bb2a',
        'branch'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.commit.message.ai.search.eefd33788c',
      'PR creation defaults'
    ),
    description: translate(
      'auto.components.settings.commit.message.ai.search.001ca3f2af',
      'Defaults used when the Create PR composer opens.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.110be48b81',
        'pull request'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.b261c88609',
        'pr'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.7e264b926b',
        'draft'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.b7d50da4d8',
        'template'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.8e9cc598d7',
        'generate'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.commit.message.ai.search.181cdb0637',
        'open'
      )
    ]
  }
])
