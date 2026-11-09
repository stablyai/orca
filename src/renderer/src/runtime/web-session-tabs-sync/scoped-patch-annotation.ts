import type { AppState } from '../../store/types'
import {
  annotateRecordReplacement,
  annotateTabBucketReplacement,
  markFullResync
} from '../../store/keyed-record-transitions'
import {
  markPatchFullResync,
  SEAM_SCOPED_TAB_RECORD_FIELDS,
  SEAM_TAB_MAP_FIELDS,
  SEAM_WORKSPACE_RECORD_FIELDS
} from '../../store/seam-record-fields'

const TAB_MAPS = SEAM_TAB_MAP_FIELDS
const WORKSPACE_KEYED_RECORDS = SEAM_WORKSPACE_RECORD_FIELDS
const TAB_KEYED_RECORDS = SEAM_SCOPED_TAB_RECORD_FIELDS
const TRACKED_RECORDS = [...TAB_MAPS, ...WORKSPACE_KEYED_RECORDS, ...TAB_KEYED_RECORDS] as const

type TrackedRecord = (typeof TRACKED_RECORDS)[number]
type ScopedPatch = Partial<Pick<AppState, TrackedRecord>>
type ScopedState = Pick<AppState, TrackedRecord>

/** Names the workspace-keyed records a workspace-scoped patch changed. Tab-keyed companions
 *  aren't inferred from visible tabs: a host retraction can delete records of tabs neither
 *  inventory lists, so callers without exact IDs mark them full resync. */
export function annotateWorkspaceScopedPatch(
  state: ScopedState,
  patch: ScopedPatch,
  workspaceIds: ReadonlySet<string>,
  // Slices another unannotated writer built first stay unaddressed, so readers resync them.
  skip: ReadonlySet<string> = new Set()
): void {
  if (patch === state) {
    return
  }
  for (const key of TAB_MAPS) {
    const next = patch[key]
    if (next && !skip.has(key)) {
      annotateTabBucketReplacement(state[key], next, workspaceIds)
    }
  }
  for (const key of WORKSPACE_KEYED_RECORDS) {
    const next = patch[key]
    if (next && !skip.has(key)) {
      annotateRecordReplacement(state[key], next, workspaceIds)
    }
  }
}

/** Host-mirror funnel: its builders don't report which tab-keyed records they touched. */
export function markTabRecordsFullResync(state: ScopedState, patch: ScopedPatch): void {
  for (const key of TAB_KEYED_RECORDS) {
    const next = patch[key]
    if (next && next !== state[key]) {
      markFullResync(next, 'host-mirror-frame')
    }
  }
}

/** A layout-frame flush: full builds are the cold path; other builds name their workspaces. */
export function annotateLayoutFlushPatch<P extends ScopedPatch>(
  state: ScopedState,
  rekeyed: ScopedPatch,
  patch: P,
  builds: {
    fullBuilt: readonly string[]
    workspaceBuilt: readonly string[]
    rebound: ReadonlyMap<string, ReadonlySet<string>>
  }
): ScopedPatch & P {
  const shown = { ...rekeyed, ...patch }
  if (builds.fullBuilt.length > 0) {
    // Cold path: a full build redraws its workspaces through save/Loader.
    markPatchFullResync(shown, 'host-mirror-frame')
    return shown
  }
  annotateWorkspaceScopedPatch(
    state,
    shown,
    new Set([...builds.workspaceBuilt, ...builds.rebound.keys()]),
    new Set(Object.keys(rekeyed))
  )
  return shown
}
