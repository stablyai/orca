import { translate } from '@/i18n/i18n'

export function activeFilterCountLabel(count: number): string {
  return count === 1
    ? translate('workspaceOptions.activeFilterCount_one', '{{count}} filter', { count })
    : translate('workspaceOptions.activeFilterCount_other', '{{count}} filters', { count })
}
