import { translate } from '@/i18n/i18n'
import type { SessionGridStateFilter } from '../../../../shared/session-grid-types'

export function sessionGridStateLabel(state: SessionGridStateFilter): string {
  switch (state) {
    case 'all':
      return translate('auto.components.session.grid.SessionGridStateControl.all', 'All')
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return translate('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
}
