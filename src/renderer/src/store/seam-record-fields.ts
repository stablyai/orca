import type { AppState } from './types'
import { markFullResync, type FullResyncReason } from './keyed-record-transitions'

// The one place that names the seam's tracked fields, so annotating writers name none themselves.
export const SEAM_TAB_MAP_FIELDS = ['tabsByWorktree', 'unifiedTabsByWorktree'] as const
export const SEAM_WORKSPACE_RECORD_FIELDS = [
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree'
] as const
export const SEAM_SCOPED_TAB_RECORD_FIELDS = [
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'runtimePaneTitlesByTabId',
  'pendingStartupByTabId'
] as const

type SeamTabMapField = (typeof SEAM_TAB_MAP_FIELDS)[number]
type TrackedField =
  | SeamTabMapField
  | (typeof SEAM_WORKSPACE_RECORD_FIELDS)[number]
  | (typeof SEAM_SCOPED_TAB_RECORD_FIELDS)[number]

export function isSeamTabMapField(field: string): field is SeamTabMapField {
  return SEAM_TAB_MAP_FIELDS.some((name) => name === field)
}

/** Cold path: every tracked record this patch replaces was rebuilt wholesale. */
export function markPatchFullResync<P extends Partial<Pick<AppState, TrackedField>>>(
  patch: P,
  reason: FullResyncReason
): P {
  for (const field of [
    ...SEAM_TAB_MAP_FIELDS,
    ...SEAM_WORKSPACE_RECORD_FIELDS,
    ...SEAM_SCOPED_TAB_RECORD_FIELDS
  ]) {
    const next = patch[field]
    if (next) {
      markFullResync(next, reason)
    }
  }
  return patch
}
