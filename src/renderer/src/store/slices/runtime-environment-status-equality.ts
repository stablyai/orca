import type { RuntimeEnvironmentStatus } from './runtime-status'
import { persistedUIValuesEqual } from '../../../../shared/persisted-ui-equality'

// Why: `checkedAt` is dropped — no consumer reads it, and a per-probe timestamp
// would make every entry unequal and defeat the caller's identity guard.
// Everything else, including fields added later, is compared structurally.
export function runtimeEnvironmentStatusesEqual(
  { checkedAt: _leftCheckedAt, ...left }: RuntimeEnvironmentStatus,
  { checkedAt: _rightCheckedAt, ...right }: RuntimeEnvironmentStatus
): boolean {
  return persistedUIValuesEqual(left, right)
}
