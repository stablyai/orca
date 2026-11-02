import type { RuntimeEnvironmentStatus } from './runtime-status'
import { persistedUIValuesEqual } from '../../../../shared/persisted-ui-equality'

// Ignore unread checkedAt to preserve identity across probes; compare all other fields, including future ones.
export function runtimeEnvironmentStatusesEqual(
  { checkedAt: _leftCheckedAt, ...left }: RuntimeEnvironmentStatus,
  { checkedAt: _rightCheckedAt, ...right }: RuntimeEnvironmentStatus
): boolean {
  return persistedUIValuesEqual(left, right)
}
