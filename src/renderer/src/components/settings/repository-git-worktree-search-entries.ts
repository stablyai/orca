import type { Repo } from '../../../../shared/types'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getRepositoryGitWorktreeSearchEntries(repo: Repo): SettingsSearchEntry[] {
  return [
    {
      title: translate(
        'auto.components.settings.repository.search.094adbe930',
        'Default Worktree Base'
      ),
      description: translate(
        'auto.components.settings.repository.search.f571081ec4',
        'Default base branch or ref when creating worktrees.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.f41cef5083',
          'base ref'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.9811f3d152', 'branch')
      ]
    },
    {
      title: translate(
        'auto.components.settings.repository.search.443d127b5a',
        'Worktree Location'
      ),
      description: translate(
        'auto.components.settings.repository.search.cd33a5525e',
        'Project-specific directory for new worktrees.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.f3e6dee5fe',
          'worktree path'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.a325a89dff',
          'workspace path'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.1ff4f12c0c',
          'directory'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.58d8bca414',
          'relative'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.4733ec2395',
          '../worktrees'
        )
      ]
    },
    {
      title: translate(
        'auto.components.settings.repository.search.1f0f20bbb6',
        'Sparse Checkout Presets'
      ),
      description: translate(
        'auto.components.settings.repository.search.90a331fd68',
        'Saved directory sets for sparse worktree creation.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.4f3c0230c2',
          'sparse'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.aa42616e3d',
          'checkout'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.095fca94fe',
          'preset'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.9f5ae26ccd',
          'presets'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.1ff4f12c0c',
          'directory'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.4e2529722c',
          'directories'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.4b9a18a56d',
          'monorepo'
        )
      ]
    },
    {
      title: translate(
        'auto.components.settings.repository.search.01b3377ebc',
        'Worktree Shared Paths'
      ),
      description: translate(
        'auto.components.settings.repository.search.ed885e589f',
        'Paths to materialize from the primary checkout into newly created worktrees.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword('auto.components.settings.repository.search.apfs', 'apfs'),
        ...translateSearchKeyword('auto.components.settings.repository.search.clone', 'clone'),
        ...translateSearchKeyword('auto.components.settings.repository.search.copy', 'copy'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.c06adcf136',
          'symlink'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.7e228fc439',
          'symlinks'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.f1c53f2820',
          'worktree'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.3c180a251c', 'link'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.fcb8fa8144',
          'shared'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.0a3a582794', 'env'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.84da7fa2d7',
          'node_modules'
        )
      ]
    }
  ]
}
