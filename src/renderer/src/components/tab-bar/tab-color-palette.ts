import { translate } from '@/i18n/i18n'

export const TAB_COLORS = [
  {
    label: translate('auto.components.tab.bar.tab.color.palette.none', 'None'),
    value: null
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.blue', 'Blue'),
    value: 'var(--color-blue-500)'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.purple', 'Purple'),
    value: 'var(--color-purple-500)'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.pink', 'Pink'),
    value: 'var(--color-pink-500)'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.red', 'Red'),
    value: 'var(--color-red-500)'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.orange', 'Orange'),
    value: 'var(--color-orange-500)'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.yellow', 'Yellow'),
    value: 'var(--color-yellow-500)'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.green', 'Green'),
    value: 'var(--color-green-500)'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.teal', 'Teal'),
    value: 'var(--color-teal-500)'
  },
  {
    label: translate('auto.components.tab.bar.tab.color.palette.gray', 'Gray'),
    value: 'var(--color-gray-500)'
  }
] as const

export const TAB_GROUP_COLORS: readonly { label: string; value: string }[] = TAB_COLORS.flatMap(
  (color) => (color.value === null ? [] : [{ label: color.label, value: color.value }])
)
