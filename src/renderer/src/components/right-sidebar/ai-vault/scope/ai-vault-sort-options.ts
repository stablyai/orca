import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  AiVaultSearchSort,
  AiVaultSort
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

export type AiVaultSortOption<Value extends string> = { value: Value; label: string }

export type AiVaultSortMenu<Value extends string> = {
  options: readonly AiVaultSortOption<Value>[]
  ariaLabel: (selectedLabel: string) => string
}

export function aiVaultBrowseSortMenu(t: Translate = translate): AiVaultSortMenu<AiVaultSort> {
  return {
    options: [
      {
        value: 'updated',
        label: t('auto.components.right.sidebar.AiVaultPanelControls.lastUpdated', 'Last updated')
      },
      {
        value: 'created',
        label: t('auto.components.right.sidebar.AiVaultPanelControls.created', 'Created')
      }
    ],
    ariaLabel: (selectedLabel) =>
      t('sessionSearch.panel.sortSessionsAriaLabel', 'Sort sessions: {{value0}}', {
        value0: selectedLabel
      })
  }
}

export function aiVaultSearchSortMenu(
  t: Translate = translate
): AiVaultSortMenu<AiVaultSearchSort> {
  return {
    options: [
      {
        value: 'relevance',
        label: t('sessionSearch.panel.sortRelevance', 'Most relevant')
      },
      { value: 'newest', label: t('sessionSearch.panel.sortNewest', 'Newest') }
    ],
    ariaLabel: (selectedLabel) =>
      t('sessionSearch.panel.sortResultsAriaLabel', 'Sort results: {{value0}}', {
        value0: selectedLabel
      })
  }
}
