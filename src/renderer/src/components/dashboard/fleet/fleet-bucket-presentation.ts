import type {
  DashboardBucket,
  DashboardCardBaseDisplayState
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'

export const FLEET_BUCKET_DOT_STATE: Record<DashboardBucket, DashboardCardBaseDisplayState> = {
  attention: 'waiting',
  working: 'working',
  done: 'done',
  idle: 'idle'
}
