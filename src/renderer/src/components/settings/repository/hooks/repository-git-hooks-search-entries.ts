import type { Repo } from '../../../../../../shared/repo-types'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import type { SettingsSearchEntry } from '../../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../../search/settings-search-keywords'

export function getRepositoryHookScriptDescription(
  repo: Repo,
  hook: 'setup' | 'archive',
  t: Translate
): string {
  if (hook === 'setup') {
    return isFolderRepo(repo)
      ? t(
          'components.settings.RepositoryHooksSection.folderSetupDescription',
          'Local and shared scripts that run after a new workspace is created.'
        )
      : t(
          'auto.components.settings.RepositoryHooksSection.30d555acd2',
          'Local and shared scripts that run after a new worktree is created.'
        )
  }
  return isFolderRepo(repo)
    ? t(
        'components.settings.RepositoryHooksSection.folderArchiveDescription',
        'Local and shared scripts that run before a workspace is removed.'
      )
    : t(
        'auto.components.settings.RepositoryHooksSection.b91a0f297d',
        'Local and shared scripts that run before a worktree is archived.'
      )
}

export function getRepositoryGitHooksSearchEntries(
  repo: Repo,
  t: Translate = translate
): SettingsSearchEntry[] {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return [
    {
      title: t('auto.components.settings.repository.search.810b9f4106', 'Setup script'),
      description: getRepositoryHookScriptDescription(repo, 'setup', t),
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
      title: t('auto.components.settings.repository.search.1617bc353d', 'Archive script'),
      description: getRepositoryHookScriptDescription(repo, 'archive', t),
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
      title: t('auto.components.settings.repository.search.cc11699c3d', 'Advanced'),
      description: t(
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
      title: t('auto.components.settings.repository.search.cedbe6c02c', 'When to run setup'),
      description: t(
        'auto.components.settings.repository.search.c00a549e03',
        'Choose the default behavior when a setup script is available.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.f9d84b7971',
          'setup run policy'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.waitForSetupBeforeAgent',
          'wait for setup before starting agent'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.waitForSetupToCompleteBeforeAgent',
          'wait for setup to complete before starting agent'
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
    ...(isFolderRepo(repo)
      ? []
      : [
          {
            title: t(
              'auto.components.settings.repository.search.aced2fc1be',
              'Custom GitHub issue command'
            ),
            description: t(
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
        ])
  ]
}
