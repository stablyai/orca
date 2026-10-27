import type { SettingsSearchEntry } from '../search/settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getLeftSidebarAppearanceEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate(
    'auto.components.settings.appearance.search.leftSidebarAppearance.0a5d3677f0',
    'Left sidebar appearance'
  ),
  description: translate(
    'auto.components.settings.appearance.search.leftSidebarAppearance.tintDescription',
    'Keep the left sidebar default or tint it. To follow the terminal, pick Match Terminal as the Light or Dark theme.'
  ),
  keywords: [
    ...translateSearchKeyword('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.leftSidebarAppearance.project',
      'project'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.leftSidebarAppearance.background',
      'background'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.leftSidebarAppearance.tint',
      'tint'
    )
  ]
}))

export const getWorkspaceCardLayoutEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate(
    'auto.components.settings.appearance.search.workspaceCardLayout.fc7c945fd9',
    'Workspace card layout'
  ),
  description: translate(
    'auto.components.settings.appearance.search.workspaceCardLayout.description',
    'Workspace cards can use compact or detailed layouts.'
  ),
  keywords: [
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.workspaceCardLayout.compact',
      'compact'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.workspaceCardLayout.compactDisplay',
      'compact display'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.workspaceCardLayout.workspaceCards',
      'workspace cards'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.workspaceCardLayout.worktreeCards',
      'worktree cards'
    ),
    ...translateSearchKeyword('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.workspaceCardLayout.cardLayout',
      'card layout'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.workspaceCardLayout.workspaceOptions',
      'workspace options'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.workspaceCardLayout.detailed',
      'detailed'
    )
  ]
}))

export const getShowPinnedWorktreesInGroupsEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.title',
      'Also show pinned worktrees in their original lists'
    ),
    description: translate(
      'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.description',
      'Pinned worktrees stay in Pinned and also appear in All, Project, Status, and PR.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.pinned',
        'pinned'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.worktree',
        'worktree'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.workspace',
        'workspace'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.all',
        'all'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.project',
        'project'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.status',
        'status'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.pr',
        'pr'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showPinnedWorktreesInGroups.duplicate',
        'duplicate'
      )
    ]
  })
)

export const getShowWorktreeUncommittedChangesEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.appearance.search.showWorktreeUncommittedChanges.title',
      'Mark workspaces with uncommitted changes'
    ),
    description: translate(
      'auto.components.settings.appearance.search.showWorktreeUncommittedChanges.description',
      'Show a stripe on workspace cards whose checkout has uncommitted or untracked changes.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showWorktreeUncommittedChanges.uncommitted',
        'uncommitted'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showWorktreeUncommittedChanges.changes',
        'changes'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showWorktreeUncommittedChanges.dirty',
        'dirty'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showWorktreeUncommittedChanges.git',
        'git'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showWorktreeUncommittedChanges.workspace',
        'workspace'
      )
    ]
  })
)

export const getSidebarEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.appearance.search.9bc701a4d1', 'Show tasks button'),
    description: translate(
      'auto.components.settings.appearance.search.9a248333c7',
      'Show the Tasks button at the top of the left sidebar.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.appearance.search.0d5a74b606', 'tasks'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.6cf5f54ce1', 'button'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.648eeada79', 'hide'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.ac79fe4a04', 'show'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.2ee4810f38', 'github'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.6b846424cc', 'linear')
    ]
  },
  {
    title: translate(
      'auto.components.settings.appearance.search.7f5d534f81',
      'Show automations button'
    ),
    description: translate(
      'auto.components.settings.appearance.search.ae13a0d340',
      'Show the Automations button at the top of the left sidebar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.b186f3cefb',
        'automations'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.58f4e22fa2',
        'automation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.4c920ab2d1',
        'schedule'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.6cf5f54ce1', 'button'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.648eeada79', 'hide'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.ac79fe4a04', 'show')
    ]
  },
  {
    title: translate(
      'auto.components.settings.appearance.search.1b404ee6ad',
      'Show Orca Mobile button'
    ),
    description: translate(
      'auto.components.settings.appearance.search.682293cadf',
      'Show the Orca Mobile button at the top of the left sidebar.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.appearance.search.74618577c7', 'mobile'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.5e5b8878bf', 'phone'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.6cf5f54ce1', 'button'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.648eeada79', 'hide'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.ac79fe4a04', 'show'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.839fb1e3ed', 'toolbox')
    ]
  },
  getWorkspaceCardLayoutEntry(),
  getLeftSidebarAppearanceEntry(),
  getShowPinnedWorktreesInGroupsEntry(),
  getShowWorktreeUncommittedChangesEntry()
])
