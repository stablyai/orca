import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

// Callers only pass counts of one or more.
export function linearLabelCountLabel(count: number, t: Translate = translate): string {
  return t('auto.components.TaskPage.labelCount', '{{count}} labels', {
    count,
    defaultValue_one: '{{count}} label'
  })
}

export function linearMemberCountLabel(count: number, t: Translate = translate): string {
  return t('auto.components.TaskPage.memberCount', '{{count}} members', {
    count,
    defaultValue_one: '{{count}} member'
  })
}
