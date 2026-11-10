// What reading a sleeping workspace's sealed snapshot can come back as (main -> renderer).
import type { ReadSnapshot } from './read-snapshot'

export type CloudReadSnapshotState =
  /** Opened on this device. `storedAt`: when the control plane stored it; show snapshot.capturedAt. */
  | { state: 'ready'; snapshot: ReadSnapshot; storedAt: number }
  /** Nothing captured yet (one is saved each time the workspace goes to sleep). */
  | { state: 'no_snapshot' }
  /** A snapshot exists but predates this device's key (or the key was pruned). Wake once to fix. */
  | { state: 'not_sealed_for_key' }
  /** No such workspace, or this account may not open it (removed, private, archived). */
  | { state: 'not_found' }
  /** This device cannot hold a reader key (no OS keychain); the feature is off here. */
  | {
      state: 'unavailable'
      reason: 'keychain_unavailable' | 'storage_failed'
      message: string
    }
