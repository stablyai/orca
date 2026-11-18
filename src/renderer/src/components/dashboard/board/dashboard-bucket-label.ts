import type { DashboardBucket } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function dashboardBucketLabel(bucket: DashboardBucket, t: Translate = translate): string {
  switch (bucket) {
    case 'attention':
      return t('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return t('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return t('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return t('dashboardPopout.bucket.idle', 'Idle')
  }
}
