// What reading a sleeping workspace's sealed snapshot can come back as (main -> renderer).
import type { ReadSnapshot } from './read-snapshot'

export type CloudReadSnapshotState =
  /** Opened on this device. `storedAt`: when the control plane stored it; show snapshot.capturedAt. */
  | { state: 'ready'; snapshot: ReadSnapshot; storedAt: number }
  /** Nothing captured yet (one is saved each time the workspace goes to sleep). */
  | { state: 'no_snapshot' }
  /** A snapshot exists but predates this device's key (or the key was pruned). Wake once to fix. */
  | { state: 'not_sealed_for_key' }
  /**
   * The control plane returned a snapshot older than one this device already opened for the
   * workspace (a rollback). Refused rather than shown as current.
   */
  | { state: 'stale' }
  /**
   * Not shown because this device cannot tell the workspace wrote it: the signature is forged, a
   * different signer than the one pinned, or unsigned after a signer was pinned.
   */
  | { state: 'unverified'; reason: 'bad_signature' | 'signer_changed' | 'unsigned' }
  /** No such workspace, or this account may not open it (removed, private, archived). */
  | { state: 'not_found' }
  /** This device cannot hold a reader key (no OS keychain); the feature is off here. */
  | {
      state: 'unavailable'
      reason: 'keychain_unavailable' | 'storage_failed'
      message: string
    }
