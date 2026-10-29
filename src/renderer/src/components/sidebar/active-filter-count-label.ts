import { translate } from '@/i18n/i18n'

export function activeFilterCountLabel(count: number): string {
  return translate('workspaceOptions.activeFilterCount', '{{count}} filters', {
    count,
    defaultValue_one: '{{count}} filter'
  })
}
