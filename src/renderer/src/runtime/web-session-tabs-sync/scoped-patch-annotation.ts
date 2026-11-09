import type { AppState } from '../../store/types'
import {
  annotateRecordReplacement,
  annotateTabBucketReplacement,
  markFullResync,
  type FullResyncReason
} from '../../store/keyed-record-transitions'

const TAB_MAPS = ['tabsByWorktree', 'unifiedTabsByWorktree'] as const
const WORKSPACE_KEYED_RECORDS = [
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree'
] as const
const TAB_KEYED_RECORDS = [
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'runtimePaneTitlesByTabId',
  'pendingStartupByTabId'
] as const
const TRACKED_RECORDS = [...TAB_MAPS, ...WORKSPACE_KEYED_RECORDS, ...TAB_KEYED_RECORDS] as const

type TrackedRecord = (typeof TRACKED_RECORDS)[number]
type ScopedPatch = Partial<Pick<AppState, TrackedRecord>>
type ScopedState = Pick<AppState, TrackedRecord>

/** Marks every tracked record `patch` replaces as rebuilt wholesale. */
export function markScopedPatchFullResync(patch: ScopedPatch, reason: FullResyncReason): void {
  for (const key of TRACKED_RECORDS) {
    const next = patch[key]
    if (next) {
      markFullResync(next, reason)
    }
  }
}

/** Names the keys a workspace-scoped patch changed: those workspaces' buckets and their tabs. */
export function annotateWorkspaceScopedPatch(
  state: ScopedState,
  patch: ScopedPatch,
  workspaceIds: ReadonlySet<string>,
  extraTabIds: Iterable<string> = [],
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
  if (!TAB_KEYED_RECORDS.some((key) => patch[key] && patch[key] !== state[key] && !skip.has(key))) {
    return
  }
  const tabIds = new Set(extraTabIds)
  for (const workspaceId of workspaceIds) {
    for (const tabs of [
      state.tabsByWorktree[workspaceId],
      patch.tabsByWorktree?.[workspaceId],
      state.unifiedTabsByWorktree[workspaceId],
      patch.unifiedTabsByWorktree?.[workspaceId]
    ]) {
      for (const tab of tabs ?? []) {
        tabIds.add('entityId' in tab ? tab.entityId : tab.id)
      }
    }
  }
  for (const key of TAB_KEYED_RECORDS) {
    const next = patch[key]
    const previous = state[key]
    if (next && previous && !skip.has(key)) {
      annotateRecordReplacement(previous, next, tabIds)
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
    markScopedPatchFullResync(shown, 'host-mirror-frame')
    return shown
  }
  annotateWorkspaceScopedPatch(
    state,
    shown,
    new Set([...builds.workspaceBuilt, ...builds.rebound.keys()]),
    [...builds.rebound.values()].flatMap((tabIds) => [...tabIds]),
    new Set(Object.keys(rekeyed))
  )
  return shown
}
