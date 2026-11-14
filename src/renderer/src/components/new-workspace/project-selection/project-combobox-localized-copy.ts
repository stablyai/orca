import { translate } from '@/i18n/i18n'

export function translateProjectOptionDetail(detail: string): string {
  return detail === 'Project'
    ? translate('auto.components.new.workspace.ProjectCombobox.projectDetail', 'Project')
    : detail
}
