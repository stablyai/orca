import type {
  DashboardBucket,
  DashboardCardBaseDisplayState
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { DASHBOARD_ATTENTION_SURFACE_CLASS } from '../board/dashboard-card-presentation'
import type { FleetBucketCounts } from './fleet-view-model'

export const FLEET_BUCKET_DOT_STATE: Record<DashboardBucket, DashboardCardBaseDisplayState> = {
  attention: 'waiting',
  working: 'working',
  done: 'done',
  idle: 'idle'
}

export function fleetFoldedAttentionClass(
  open: boolean,
  counts: FleetBucketCounts
): string | undefined {
  return !open && counts.attention > 0 ? DASHBOARD_ATTENTION_SURFACE_CLASS : undefined
}
