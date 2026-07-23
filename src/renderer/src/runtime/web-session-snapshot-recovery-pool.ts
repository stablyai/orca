import { mapWithConcurrency } from '../../../shared/map-with-concurrency'

export const WEB_SESSION_SNAPSHOT_RECOVERY_CONCURRENCY = 4

export function mapWebSessionSnapshotRecoveries<T, R>(
  snapshots: readonly T[],
  recover: (snapshot: T, index: number) => Promise<R>
): Promise<R[]> {
  return mapWithConcurrency(snapshots, WEB_SESSION_SNAPSHOT_RECOVERY_CONCURRENCY, recover)
}
