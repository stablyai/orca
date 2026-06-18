import { getAutoRenameBranchSearchEntries } from './auto-rename-branch-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getGitPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.git.search.68bd65fdb8', 'Branch Prefix'),
    description: translate(
      'auto.components.settings.git.search.5ecd91c5ef',
      'Prefix added to branch names when creating worktrees.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.git.search.f83c8937c4', 'branch naming'),
      ...translateSearchKeyword('auto.components.settings.git.search.1d2fae1fa2', 'git username'),
      ...translateSearchKeyword('auto.components.settings.git.search.769ddd7f81', 'custom')
    ]
  },
  {
    title: translate(
      'auto.components.settings.git.search.f8bda25f29',
      'Keep Local Main Up to Date'
    ),
    description: translate(
      'auto.components.settings.git.search.0e993bf00f',
      'When you create a workspace, Orca refreshes the remote base and safely fast-forwards your matching local branch, such as main or master. This keeps commands like git diff main...HEAD from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.git.search.e3e9adde59', 'main'),
      ...translateSearchKeyword('auto.components.settings.git.search.28192e3a63', 'master'),
      ...translateSearchKeyword('auto.components.settings.git.search.564942ffc5', 'origin/main'),
      ...translateSearchKeyword('auto.components.settings.git.search.6ee3cfff02', 'git diff'),
      ...translateSearchKeyword('auto.components.settings.git.search.c41e345153', 'behind main'),
      ...translateSearchKeyword('auto.components.settings.git.search.0849b571fe', 'up to date'),
      ...translateSearchKeyword('auto.components.settings.git.search.d9f70d51a0', 'stale main'),
      ...translateSearchKeyword(
        'auto.components.settings.git.search.ab0e22c9f6',
        'refresh local main'
      ),
      ...translateSearchKeyword('auto.components.settings.git.search.de06e9d105', 'base ref'),
      ...translateSearchKeyword('auto.components.settings.git.search.bae91effdd', 'fresh base'),
      ...translateSearchKeyword('auto.components.settings.git.search.0c75583ca9', 'safely'),
      ...translateSearchKeyword('auto.components.settings.git.search.035134fcd9', 'worktree')
    ]
  },
  ...getAutoRenameBranchSearchEntries(),
  {
    title: translate('auto.components.settings.git.search.bc7d9f69ce', 'Orca Attribution'),
    description: translate(
      'auto.components.settings.git.search.118c23484b',
      'Add Orca attribution to commits, PRs, and issues.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.git.search.d088806071', 'github'),
      ...translateSearchKeyword('auto.components.settings.git.search.16f53f7323', 'gh'),
      ...translateSearchKeyword('auto.components.settings.git.search.6bdea421bb', 'pr'),
      ...translateSearchKeyword('auto.components.settings.git.search.af0a144bfb', 'issue'),
      ...translateSearchKeyword('auto.components.settings.git.search.61f9f5d1fc', 'co-author'),
      ...translateSearchKeyword('auto.components.settings.git.search.8461c908ae', 'coauthored'),
      ...translateSearchKeyword('auto.components.settings.git.search.1b93c1143c', 'attribution'),
      ...translateSearchKeyword('auto.components.settings.git.search.61eab13403', 'orca')
    ]
  }
])
