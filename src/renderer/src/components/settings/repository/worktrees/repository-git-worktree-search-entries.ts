import type { Repo } from '../../../../../../shared/repo-types'
import type { SettingsSearchEntry } from '../../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../../search/settings-search-keywords'

function getRepositoryGitWorktreeSearchParts(repo: Repo, t: Translate = translate) {
  const translateSearchKeyword = searchKeywordTranslator(t)
  const entries = {
    externalWorktrees: {
      title: t(
        'auto.components.settings.repository.search.externalWorktrees',
        'External worktrees'
      ),
      description: t(
        'auto.components.settings.repository.search.externalWorktreesDescription',
        'Override whether worktrees created outside Orca appear for this project.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.external',
          'external'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.visibility',
          'visibility'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.sidebar', 'sidebar')
      ]
    },
    base: {
      title: t('auto.components.settings.repository.search.88d466b2e3', 'Default worktree base'),
      description: t(
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
    location: {
      title: t('auto.components.settings.repository.search.2e216fbad2', 'Worktree location'),
      description: t(
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
    sparsePresets: {
      title: t('auto.components.settings.repository.search.355868ac19', 'Sparse checkout presets'),
      description: t(
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
    sharedPaths: {
      title: t('auto.components.settings.repository.search.ea22e2187e', 'Worktree shared paths'),
      description: t(
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
  } satisfies Record<string, SettingsSearchEntry>
  return entries
}

export function getRepositoryGitWorktreeSearchEntries(
  repo: Repo,
  t: Translate = translate
): SettingsSearchEntry[] {
  const entries = getRepositoryGitWorktreeSearchParts(repo, t)
  return [
    entries.externalWorktrees,
    entries.base,
    entries.location,
    entries.sparsePresets,
    entries.sharedPaths
  ]
}

export function getRepositoryGitWorktreeSearchMetadata(repo: Repo, t: Translate = translate) {
  const entries = getRepositoryGitWorktreeSearchParts(repo, t)
  return {
    identity: [entries.externalWorktrees, entries.base, entries.location],
    sparsePresets: [entries.sparsePresets],
    sharedPaths: [entries.sharedPaths]
  }
}
