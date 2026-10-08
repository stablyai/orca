/** Words for moving what an older build added to a converted host; every string is catalogued. */
import type { OrcadDeltaMoveRow } from '../../../../shared/orcad-managed-runtime'
import { translate } from '@/i18n/i18n'

export function deltaMoveRowLabel(row: OrcadDeltaMoveRow): string {
  switch (row.kind) {
    case 'repository':
      return translate(
        'auto.components.settings.deltaMove.kind.repository',
        'Repository {{name}}',
        {
          name: row.label
        }
      )
    case 'folder-workspace':
      return translate('auto.components.settings.deltaMove.kind.folder', 'Folder {{name}}', {
        name: row.label
      })
    case 'project-group':
      return translate('auto.components.settings.deltaMove.kind.group', 'Project group {{name}}', {
        name: row.label
      })
  }
}
