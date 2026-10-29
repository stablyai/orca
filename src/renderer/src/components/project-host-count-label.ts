import { translate } from '@/i18n/i18n'

export function projectHostCountLabel(count: number): string {
  return translate('auto.components.task.project.source.combobox.hostCount', '{{count}} hosts', {
    count,
    defaultValue_one: '{{count}} host'
  })
}
