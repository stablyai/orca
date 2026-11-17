// LIFECYCLE-MATRIX: which action an Orca Cloud workspace offers in each lifecycle state, for every
// surface (sidebar menu, status panel menu, team list menu, the archived and asleep pages, the delete
// dialog, the tab "+" menu). Surfaces ask cloudWorkspaceActions(state) instead of deciding alone, so
// they can't disagree. The table is the spec: .context/cloud/reports/lifecycle-action-matrix.md.
import type { CloudDotState } from './orca-cloud-workspace-state'

export type CloudLifecycleState =
  | 'running'
  | 'asleep'
  | 'waking'
  | 'wakeFailed'
  | 'archived'
  /** "Move to this computer" is copying it. */
  | 'moving'
  /** Delete is under way (or done). */
  | 'deleted'

export type CloudLifecycleAction =
  | 'wake'
  | 'sleep'
  | 'restart'
  | 'archive'
  | 'unarchive'
  | 'moveToComputer'
  | 'delete'
  /** The delete dialog's "Archive instead". */
  | 'archiveInsteadOfDelete'
  /** Tab "+" menu only. */
  | 'remoteDesktop'
  /** New terminal or agent tabs (tab "+" menu). */
  | 'newTab'
  /** "Open in ›" editors and the "SSH ›" submenu: they connect to the VM (an asleep one wakes). */
  | 'openIn'
  | 'copyPath'
  | 'copyName'
  /** Mark Read/Unread, mute, Edit Details, Pin, Move to Status: this computer's own bookkeeping. */
  | 'organize'

/** show: offered and enabled; disabled: offered greyed (it applies, just not right now); hide. */
export type CloudActionAvailability = 'show' | 'disabled' | 'hide'

const S = 'show'
const D = 'disabled'
const H = 'hide'

// Columns: running, asleep, waking, wakeFailed, archived, moving, deleted.
const MATRIX: Record<CloudLifecycleAction, readonly CloudActionAvailability[]> = {
  wake: [H, S, H, S, H, H, H],
  sleep: [S, H, H, H, H, D, H],
  restart: [S, H, S, S, H, D, H],
  archive: [S, S, D, S, H, D, H],
  unarchive: [H, H, H, H, S, H, H],
  moveToComputer: [S, S, D, S, S, D, H],
  delete: [S, S, S, S, S, D, D],
  archiveInsteadOfDelete: [S, S, H, S, H, H, H],
  remoteDesktop: [S, H, H, H, H, S, H],
  newTab: [S, S, S, S, H, S, H],
  openIn: [S, S, S, H, H, S, H],
  copyPath: [S, S, S, S, H, S, H],
  copyName: [S, S, S, S, S, S, H],
  organize: [S, S, S, S, S, S, D]
}

const COLUMN: Record<CloudLifecycleState, number> = {
  running: 0,
  asleep: 1,
  waking: 2,
  wakeFailed: 3,
  archived: 4,
  moving: 5,
  deleted: 6
}

export type CloudWorkspaceActions = {
  availability: (action: CloudLifecycleAction) => CloudActionAvailability
  /** Offered at all (shown, enabled or not). */
  offers: (action: CloudLifecycleAction) => boolean
  /** Offered and enabled now. */
  allows: (action: CloudLifecycleAction) => boolean
}

export function cloudWorkspaceActions(state: CloudLifecycleState): CloudWorkspaceActions {
  const column = COLUMN[state]
  const availability = (action: CloudLifecycleAction): CloudActionAvailability =>
    MATRIX[action][column] ?? H
  return {
    availability,
    offers: (action) => availability(action) !== H,
    allows: (action) => availability(action) === S
  }
}

/** The lifecycle column for a workspace's dot state, a move in flight and a delete under way. */
export function cloudLifecycleState(
  dot: CloudDotState,
  extra: { moving?: boolean; deleting?: boolean } = {}
): CloudLifecycleState {
  if (extra.deleting) {
    return 'deleted'
  }
  if (extra.moving) {
    return 'moving'
  }
  switch (dot) {
    case 'sleeping':
      return 'asleep'
    case 'waking':
    case 'starting':
      return 'waking'
    case 'wakeFailed':
    case 'failed':
      return 'wakeFailed'
    case 'archived':
      return 'archived'
    // Unresponsive answers Restart like a running one; unknown keeps the running rows (disabled
    // where they would act on a status not read yet; surfaces gate that themselves).
    case 'running':
    case 'unresponsive':
    case 'unknown':
      return 'running'
  }
}

/** The team list's server status (no dot state there) in the same columns. */
export function cloudLifecycleStateFromServer(
  status: string,
  archivedAt: number | null
): CloudLifecycleState {
  if (archivedAt !== null || status === 'archived') {
    return 'archived'
  }
  switch (status) {
    case 'suspended':
      return 'asleep'
    case 'resuming':
    case 'starting':
    case 'provisioning':
    case 'suspending':
      return 'waking'
    case 'failed':
      return 'wakeFailed'
    case 'destroying':
    case 'destroyed':
      return 'deleted'
    default:
      return 'running'
  }
}

export const CLOUD_LIFECYCLE_MATRIX_FOR_DOCS = { MATRIX, COLUMN }
