import { translate } from '@/i18n/i18n'

export function projectHostCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.task.project.source.combobox.hostCount_one', '{{count}} host', {
        count
      })
    : translate('auto.components.task.project.source.combobox.hostCount_other', '{{count}} hosts', {
        count
      })
}
