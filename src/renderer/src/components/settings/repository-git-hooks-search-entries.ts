import type { Repo } from '../../../../shared/types'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getRepositoryGitHooksSearchEntries(repo: Repo): SettingsSearchEntry[] {
  return [
    {
      title: translate('auto.components.settings.repository.search.b79df26937', 'Setup Script'),
      description: translate(
        'auto.components.settings.repository.search.baaf70bb37',
        'Local and shared scripts that run after a new worktree is created.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword('auto.components.settings.repository.search.8655e3387b', 'hooks'),
        ...translateSearchKeyword('auto.components.settings.repository.search.5590388dfa', 'setup'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.a31b43a7f8',
          'setup script'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.491b05d6e6',
          'setup command'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.6b80f7d3c8',
          'local settings scripts'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.9cad92fe77',
          'orca.yaml hooks'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.bf460fded8', 'yaml')
      ]
    },
    {
      title: translate('auto.components.settings.repository.search.bce0ca23c6', 'Archive Script'),
      description: translate(
        'auto.components.settings.repository.search.acd1157f0c',
        'Local and shared scripts that run before a worktree is archived.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword('auto.components.settings.repository.search.8655e3387b', 'hooks'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.4c17787d7b',
          'archive'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.fbfd2386e8',
          'archive script'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.a1a4c51d58',
          'archive command'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.6b80f7d3c8',
          'local settings scripts'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.9cad92fe77',
          'orca.yaml hooks'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.bf460fded8', 'yaml')
      ]
    },
    {
      title: translate('auto.components.settings.repository.search.cc11699c3d', 'Advanced'),
      description: translate(
        'auto.components.settings.repository.search.d141897c90',
        'Command source and orca.yaml details.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.19f58d6d89',
          'advanced'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.ed269fad69',
          'command source'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.0432d2fb7c', 'local'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.603c68b68c',
          'orca.yaml'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.fcb8fa8144',
          'shared'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.1d90a6cfbb', 'both'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.f1e1bfa89f',
          'source'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.5e9445bbfd',
          'authoritative'
        )
      ]
    },
    {
      title: translate(
        'auto.components.settings.repository.search.cdfe398068',
        'When to Run Setup'
      ),
      description: translate(
        'auto.components.settings.repository.search.c00a549e03',
        'Choose the default behavior when a setup script is available.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.f9d84b7971',
          'setup run policy'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.80c490b012', 'ask'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.a69c5cbe90',
          'run by default'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.c5e8bdbcbb',
          'skip by default'
        )
      ]
    },
    {
      title: translate(
        'auto.components.settings.repository.search.d86ea12d16',
        'Custom GitHub Issue Command'
      ),
      description: translate(
        'auto.components.settings.repository.search.d42d1e49c0',
        'File-based linked-issue command configured via orca.yaml and optional local override.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.2011a6a4f2',
          'github issue command'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.66b584bd6c',
          'issue command'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.ec70364df2',
          'workflow'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.9dc60d7f6d',
          'github'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.603c68b68c',
          'orca.yaml'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.bc7e504b8e',
          '.orca/issue-command'
        )
      ]
    }
  ]
}
