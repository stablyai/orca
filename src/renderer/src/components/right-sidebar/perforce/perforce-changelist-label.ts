import { translate } from '@/i18n/i18n'
import type { PerforceChangelist } from '../../../../../shared/perforce/perforce-types'

/** "Changelist 12 · first description line", used wherever a changelist is picked from a list. */
export function perforceChangelistLabel(changelist: PerforceChangelist): string {
  const label = translate('perforce.ui.changelistNumber', 'Changelist {{id}}', {
    id: changelist.id
  })
  const firstLine = changelist.description.split('\n')[0]
  return firstLine ? `${label} · ${firstLine}` : label
}
