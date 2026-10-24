import { translate } from '@/i18n/i18n'

// Why whole sentences per count: the plural ending used to travel as an
// interpolation value, which glued an English "s" onto translated nouns.
// Both callers show these only for a count of one or more.
export function linearLabelCountLabel(count: number): string {
  return count > 1
    ? translate('auto.components.TaskPage.labelCountPlural', '{{count}} labels', { count })
    : translate('auto.components.TaskPage.labelCountSingular', '{{count}} label', { count })
}

export function linearMemberCountLabel(count: number): string {
  return count > 1
    ? translate('auto.components.TaskPage.memberCountPlural', '{{count}} members', { count })
    : translate('auto.components.TaskPage.memberCountSingular', '{{count}} member', { count })
}
