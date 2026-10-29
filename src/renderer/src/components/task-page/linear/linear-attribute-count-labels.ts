import { translate } from '@/i18n/i18n'

// Callers only pass counts of one or more.
export function linearLabelCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.TaskPage.labelCount_one', '{{count}} label', { count })
    : translate('auto.components.TaskPage.labelCount_other', '{{count}} labels', { count })
}

export function linearMemberCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.TaskPage.memberCount_one', '{{count}} member', { count })
    : translate('auto.components.TaskPage.memberCount_other', '{{count}} members', { count })
}
