import type { WorkspaceSessionState } from './workspace-session-state-types'

import type {
  SessionChangeSet,
  SessionFieldPresenceIntent,
  SessionAdmissionKind,
  SessionUnitChange,
  SessionMapField
} from './session-change-set'
import type { SessionUnitSelection } from './session-unit-selection'
import type { SessionUnitReader } from './session-unit-reader'
export type SessionPresence<T> = { present: true; value: T } | { present: false; value: undefined }
export type SessionScalarField = Exclude<keyof WorkspaceSessionState, SessionMapField>
export type SessionPolicyField =
  | 'terminalSurfaceTombstonesByPaneKey'
  | 'terminalTopologyRevisionByRepoId'
  | 'closedTerminalTabTombstonesByTabId'
  | 'browserUrlHistory'
  | 'workspaceDocHistory'
  | 'activeWorktreeIdsOnShutdown'
  | 'activeConnectionIdsAtShutdown'
export type SessionEntry<F extends SessionMapField> = NonNullable<WorkspaceSessionState[F]>[string]

export type SessionUnitView = Pick<
  SessionUnitReader,
  'unit' | 'field' | 'hasField' | 'map' | 'index' | 'references'
>

export function isSessionUnitView(
  source: WorkspaceSessionState | SessionUnitView
): source is SessionUnitView {
  return 'unit' in source
}

export type FieldTransition = {
  base: SessionPresence<unknown>
  entries?: Map<string, SessionPresence<unknown>>
  count: number
  intent?: SessionFieldPresenceIntent
  complete: boolean
  resolved?: SessionPresence<unknown>
}

export type PreparedSession = {
  prior: WorkspaceSessionState
  root: WorkspaceSessionState
  kind: SessionAdmissionKind
  fullReplacement: boolean
  partitionDeleted: boolean
  affected: Pick<SessionChangeSet, 'owners' | 'tabs' | 'panes' | 'files' | 'pages' | 'repos'> & {
    units: SessionUnitSelection
  }
  units: readonly SessionUnitChange[]
  orders: ReadonlyMap<SessionMapField, readonly string[]>
  relatedViews?: ReadonlyMap<string, { prior: unknown; next: unknown }>
  effects: readonly (() => void)[]
}
