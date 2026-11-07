import { translate } from '@/i18n/i18n'

// Callers only pass counts of one or more.
export function linearLabelCountLabel(count: number): string {
  return translate('auto.components.TaskPage.labelCount', '{{count}} labels', {
    count,
    defaultValue_one: '{{count}} label'
  })
}

export function linearMemberCountLabel(count: number): string {
  return translate('auto.components.TaskPage.memberCount', '{{count}} members', {
    count,
    defaultValue_one: '{{count}} member'
  })
}
