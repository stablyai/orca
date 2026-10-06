import { translate } from '@/i18n/i18n'
import type { AiVaultSearchSort, AiVaultSort } from '../../../../shared/ai-vault-types'

export type AiVaultSortOption<Value extends string> = { value: Value; label: string }

/** One mode's sort menu: its choices, and the accessible name of the trigger showing one. */
export type AiVaultSortMenu<Value extends string> = {
  options: readonly AiVaultSortOption<Value>[]
  ariaLabel: (selectedLabel: string) => string
}

export function aiVaultBrowseSortMenu(): AiVaultSortMenu<AiVaultSort> {
  return {
    options: [
      {
        value: 'updated',
        label: translate(
          'auto.components.right.sidebar.AiVaultPanelControls.lastUpdated',
          'Last updated'
        )
      },
      {
        value: 'created',
        label: translate('auto.components.right.sidebar.AiVaultPanelControls.created', 'Created')
      }
    ],
    ariaLabel: (selectedLabel) =>
      translate('sessionSearch.panel.sortSessionsAriaLabel', 'Sort sessions: {{value0}}', {
        value0: selectedLabel
      })
  }
}

export function aiVaultSearchSortMenu(): AiVaultSortMenu<AiVaultSearchSort> {
  return {
    options: [
      {
        value: 'relevance',
        label: translate('sessionSearch.panel.sortRelevance', 'Most relevant')
      },
      { value: 'newest', label: translate('sessionSearch.panel.sortNewest', 'Newest') }
    ],
    ariaLabel: (selectedLabel) =>
      translate('sessionSearch.panel.sortResultsAriaLabel', 'Sort results: {{value0}}', {
        value0: selectedLabel
      })
  }
}
