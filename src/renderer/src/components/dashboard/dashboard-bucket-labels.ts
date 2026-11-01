import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { translate } from '@/i18n/i18n'

export function dashboardBucketLabel(bucket: DashboardBucket): string {
  switch (bucket) {
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return translate('dashboardPopout.bucket.done', 'Turn ended')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
}

export function dashboardTurnEndedDescription(): string {
  return translate(
    'dashboardPopout.bucket.doneDescription',
    'An agent turn ended. Task acceptance has not been verified.'
  )
}
