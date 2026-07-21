import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export type TabColorOption = {
  readonly label: string
  readonly value: string | null
}

export const getTabColorOptions = createLocalizedCatalog((): readonly TabColorOption[] => [
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.20baa43c05', 'None'),
    value: null
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.cb3eadefd2', 'Blue'),
    value: '#3b82f6'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.c2d8b0991f', 'Purple'),
    value: '#a855f7'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.03cf6dab1a', 'Pink'),
    value: '#ec4899'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.620aec6729', 'Red'),
    value: '#ef4444'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.a47629b3cf', 'Orange'),
    value: '#f97316'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.69682e2ce4', 'Yellow'),
    value: '#eab308'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.be905e9b0a', 'Green'),
    value: '#22c55e'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.845576bed1', 'Teal'),
    value: '#14b8a6'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.7703990447', 'Gray'),
    value: '#9ca3af'
  }
])
