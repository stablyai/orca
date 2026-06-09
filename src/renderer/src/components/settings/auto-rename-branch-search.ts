import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAutoRenameBranchParentSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.auto.rename.branch.search.427f2cd1eb',
      'Auto-Rename Branch'
    ),
    description: translate(
      'auto.components.settings.auto.rename.branch.search.ea94b9da8a',
      'Rename the auto-generated branch based on the work once an agent starts.'
    ),
    keywords: [
      translate('auto.components.settings.auto.rename.branch.search.9319bd9827', 'branch'),
      translate('auto.components.settings.auto.rename.branch.search.55a1860e47', 'rename'),
      translate('auto.components.settings.auto.rename.branch.search.7803423877', 'auto'),
      translate('auto.components.settings.auto.rename.branch.search.f0acf64301', 'creature name'),
      translate('auto.components.settings.auto.rename.branch.search.3ef3cbe98c', 'agent'),
      translate('auto.components.settings.auto.rename.branch.search.40d21f2efc', 'prompt'),
      translate('auto.components.settings.auto.rename.branch.search.10485c4fc5', 'command'),
      translate('auto.components.settings.auto.rename.branch.search.7adefcdd94', 'template'),
      translate('auto.components.settings.auto.rename.branch.search.ed677944cc', 'worktree'),
      translate('auto.components.settings.auto.rename.branch.search.a482f6a423', 'slug'),
      translate('auto.components.settings.auto.rename.branch.search.f41833025e', 'generate')
    ]
  })
)

export const getAutoRenameBranchAdvancedSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.auto.rename.branch.search.722551c5b3',
      'Branch name command template'
    ),
    description: translate(
      'auto.components.settings.auto.rename.branch.search.672387fb77',
      'Agent command template used when generating branch names.'
    ),
    keywords: [
      translate('auto.components.settings.auto.rename.branch.search.40d21f2efc', 'prompt'),
      translate('auto.components.settings.auto.rename.branch.search.502aa57681', 'instructions'),
      translate('auto.components.settings.auto.rename.branch.search.50139297e6', 'built-in prompt'),
      translate('auto.components.settings.auto.rename.branch.search.10485c4fc5', 'command'),
      translate('auto.components.settings.auto.rename.branch.search.7adefcdd94', 'template'),
      translate('auto.components.settings.auto.rename.branch.search.a482f6a423', 'slug'),
      translate('auto.components.settings.auto.rename.branch.search.0971762141', 'kebab-case')
    ]
  }
])

export const getAutoRenameBranchSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    getAutoRenameBranchParentSearchEntry(),
    ...getAutoRenameBranchAdvancedSearchEntries()
  ]
)
