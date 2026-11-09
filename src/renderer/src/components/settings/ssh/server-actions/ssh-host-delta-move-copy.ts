import type { OrcadDeltaMoveRow } from '../../../../../../shared/orcad-managed-runtime'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function deltaMoveRowLabel(row: OrcadDeltaMoveRow, t: Translate = translate): string {
  switch (row.kind) {
    case 'repository':
      return t('auto.components.settings.deltaMove.kind.repository', 'Repository {{name}}', {
        name: row.label
      })
    case 'folder-workspace':
      return t('auto.components.settings.deltaMove.kind.folder', 'Folder {{name}}', {
        name: row.label
      })
    case 'project-group':
      return t('auto.components.settings.deltaMove.kind.group', 'Project group {{name}}', {
        name: row.label
      })
  }
}
