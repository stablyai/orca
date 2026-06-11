import { translate } from '@/i18n/i18n'

export const TAB_COLORS = [
  {
    label: translate('auto.components.tab.bar.tab.color.palette.none', 'None'),
    value: null
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.blue', 'Blue'),
    value: '#3b82f6'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.purple', 'Purple'),
    value: '#a855f7'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.pink', 'Pink'),
    value: '#ec4899'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.red', 'Red'),
    value: '#ef4444'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.orange', 'Orange'),
    value: '#f97316'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.yellow', 'Yellow'),
    value: '#eab308'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.green', 'Green'),
    value: '#22c55e'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.teal', 'Teal'),
    value: '#14b8a6'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.gray', 'Gray'),
    value: '#9ca3af'
  }
] as const

export const TAB_GROUP_COLORS: readonly { label: string; value: string }[] = TAB_COLORS.flatMap(
  (color) => (color.value === null ? [] : [{ label: color.label, value: color.value }])
)
