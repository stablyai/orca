import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getWorkspaceTitleLanguageSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'settings.sourceControl.workspaceTitleLanguage.title',
      'Workspace title language'
    ),
    description: translate(
      'settings.sourceControl.workspaceTitleLanguage.description',
      'Choose the language for new automatic workspace titles. Git branch names stay in English. Existing and manually edited titles are kept.'
    ),
    keywords: translateSearchKeyword(
      'settings.sourceControl.workspaceTitleLanguage.keywords',
      'workspace title language Chinese'
    )
  })
)

export const getAutoRenameBranchParentSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.auto.rename.branch.search.427f2cd1eb',
      'Auto-rename branch & worktree'
    ),
    description: translate(
      'auto.components.settings.auto.rename.branch.search.ea94b9da8a',
      'Rename the auto-generated branch based on the work once an agent starts.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.9319bd9827',
        'branch'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.55a1860e47',
        'rename'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.7803423877',
        'auto'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.f0acf64301',
        'creature name'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.3ef3cbe98c',
        'agent'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.40d21f2efc',
        'prompt'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.10485c4fc5',
        'command'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.7adefcdd94',
        'template'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.ed677944cc',
        'worktree'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.a482f6a423',
        'slug'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.f41833025e',
        'generate'
      )
    ]
  })
)

export const AUTO_RENAME_BRANCH_TEMPLATE_SETTING_ID = 'git-auto-rename-branch-template'

export const getAutoRenameBranchAdvancedSearchEntries = createLocalizedCatalog(() => [
  {
    targetSectionId: AUTO_RENAME_BRANCH_TEMPLATE_SETTING_ID,
    title: translate(
      'auto.components.settings.auto.rename.branch.search.722551c5b3',
      'Branch name command template'
    ),
    description: translate(
      'auto.components.settings.auto.rename.branch.search.672387fb77',
      'Agent command template used when generating branch names.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.40d21f2efc',
        'prompt'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.502aa57681',
        'instructions'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.50139297e6',
        'built-in prompt'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.10485c4fc5',
        'command'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.7adefcdd94',
        'template'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.a482f6a423',
        'slug'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auto.rename.branch.search.0971762141',
        'kebab-case'
      )
    ]
  }
])

export const getAutoRenameBranchSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    getAutoRenameBranchParentSearchEntry(),
    getWorkspaceTitleLanguageSearchEntry(),
    ...getAutoRenameBranchAdvancedSearchEntries()
  ]
)
