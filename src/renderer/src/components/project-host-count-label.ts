import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function projectHostCountLabel(count: number, t: Translate = translate): string {
  return t('auto.components.task.project.source.combobox.hostCount', '{{count}} hosts', {
    count,
    defaultValue_one: '{{count}} host'
  })
}
