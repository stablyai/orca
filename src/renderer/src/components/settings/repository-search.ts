import type { Repo } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { getRepositoryGitAuthorSearchEntries } from './repository-git-author-search-entries'
import { getRepositoryGitHooksSearchEntries } from './repository-git-hooks-search-entries'
import { getRepositoryGitWorktreeSearchEntries } from './repository-git-worktree-search-entries'

export function getRepositoryPaneSearchEntries(repo: Repo): SettingsSearchEntry[] {
  const isFolder = isFolderRepo(repo)
  return [
    {
      title: translate('auto.components.settings.repository.search.7e1e456a95', 'Display Name'),
      description: translate(
        'auto.components.settings.repository.search.883aad2801',
        'Project-specific display details for the sidebar and tabs.'
      ),
      keywords: [
        repo.displayName,
        repo.path,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.92af66c7ce',
          'project name'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.cd73b976d7',
          'repository name'
        )
      ]
    },
    {
      title: translate('auto.components.settings.repository.search.b24f00294a', 'Project Icon'),
      description: translate(
        'auto.components.settings.repository.search.a1f3a2bd47',
        'Project icon and color used in the sidebar and tabs.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.6438a94c63',
          'project icon'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.b2546efab5',
          'repository icon'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.8d045419b1', 'color'),
        ...translateSearchKeyword('auto.components.settings.repository.search.6d8de2f090', 'hex'),
        ...translateSearchKeyword('auto.components.settings.repository.search.c1075178cf', 'badge'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.cb4b4de666',
          'avatar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.9dc60d7f6d',
          'github'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.1e73e840ff', 'emoji'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.27733eb6c1',
          'favicon'
        )
      ]
    },
    ...(repo.upstream && !isFolder
      ? [
          {
            title: translate(
              'auto.components.settings.repository.search.keepForkUpToDate',
              'Keep Fork Up to Date'
            ),
            description: translate(
              'auto.components.settings.repository.search.keepForkUpToDateDescription',
              'Safely fast-forward this fork from upstream.'
            ),
            keywords: [
              repo.displayName,
              repo.upstream.owner,
              repo.upstream.repo,
              ...translateSearchKeyword('auto.components.settings.repository.search.fork', 'fork'),
              ...translateSearchKeyword(
                'auto.components.settings.repository.search.upstream',
                'upstream'
              ),
              ...translateSearchKeyword(
                'auto.components.settings.repository.search.syncFork',
                'sync fork'
              ),
              ...translateSearchKeyword(
                'auto.components.settings.repository.search.fastForward',
                'fast-forward'
              ),
              ...translateSearchKeyword(
                'auto.components.settings.repository.search.behindUpstream',
                'behind upstream'
              ),
              ...translateSearchKeyword(
                'auto.components.settings.repository.search.origin',
                'origin'
              ),
              ...translateSearchKeyword(
                'auto.components.settings.repository.search.defaultBranch',
                'default branch'
              )
            ]
          }
        ]
      : []),
    ...(isFolder ? [] : getRepositoryGitWorktreeSearchEntries(repo)),
    {
      title: translate('auto.components.settings.repository.search.c5266c2c9d', 'Remove Project'),
      description: translate(
        'auto.components.settings.repository.search.c86478c3d8',
        'Remove this project from Orca.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.3067595d82',
          'delete'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.6469de5368',
          'project'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.cc876ca5f2',
          'repository'
        )
      ]
    },
    {
      title: translate('auto.components.settings.repository.search.b24f00294a', 'Project Icon'),
      description: translate(
        'auto.components.settings.repository.search.a1f3a2bd47',
        'Project icon and color used in the sidebar and tabs.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.6438a94c63',
          'project icon'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.b2546efab5',
          'repository icon'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.8d045419b1', 'color'),
        ...translateSearchKeyword('auto.components.settings.repository.search.6d8de2f090', 'hex'),
        ...translateSearchKeyword('auto.components.settings.repository.search.c1075178cf', 'badge'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.cb4b4de666',
          'avatar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.9dc60d7f6d',
          'github'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.1e73e840ff', 'emoji'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.27733eb6c1',
          'favicon'
        )
      ]
    },
    ...(isFolder ? [] : getRepositoryGitWorktreeSearchEntries(repo)),
    ...(isFolder
      ? []
      : [...getRepositoryGitAuthorSearchEntries(repo), ...getRepositoryGitHooksSearchEntries(repo)])
  ]
}
