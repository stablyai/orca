import type { AppState } from '../../store/types'
import { markPatchFullResync } from '../../store/seam-record-fields'

/** Host-mirror funnel: imported host snapshots replace each tracked record they touch wholesale. */
export function markHostMirrorPatchFullResync(
  state: Partial<AppState>,
  patch: Partial<AppState>
): void {
  if (patch !== state) {
    // Cold path: host session snapshots are rebuilt into the store, not written key by key.
    markPatchFullResync(patch, 'host-mirror-frame', state)
  }
}
