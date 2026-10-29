import type { ExecutionHostId } from './execution-host'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { copySessionRecord } from './session-record-edit'

export const SESSION_MAP_FIELDS = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'localOnlyScrollbackByTabId',
  'openFilesByWorktree',
  'activeFileIdByWorktree',
  'markdownFrontmatterVisible',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'activeBrowserTabIdByWorktree',
  'clientHostedBrowserPagesByWorktree',
  'clientHostedBrowserCloseIntentsByEnvironment',
  'pairedTerminalTabCloseIntentsByEnvironment',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'remoteSessionIdsByTabId',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'sleepingAgentSessionsByPaneKey',
  'terminalPtyIncarnationsByPaneKey',
  'terminalTopologyRevisionByRepoId',
  'terminalSurfaceTombstonesByPaneKey',
  'closedTerminalTabTombstonesByTabId',
  'closedTerminalPanesByPaneKey'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

export const SESSION_FIELD_POLICY = {
  tabsByWorktree: { undefined: 'empty', empty: 'keep' },
  terminalLayoutsByTabId: { undefined: 'empty', empty: 'keep' },
  localOnlyScrollbackByTabId: { undefined: 'asWritten', empty: 'keep' },
  openFilesByWorktree: { undefined: 'asWritten', empty: 'keep' },
  activeFileIdByWorktree: { undefined: 'asWritten', empty: 'keep' },
  markdownFrontmatterVisible: { undefined: 'asWritten', empty: 'keep' },
  browserTabsByWorktree: { undefined: 'asWritten', empty: 'keep' },
  browserPagesByWorkspace: { undefined: 'asWritten', empty: 'keep' },
  activeBrowserTabIdByWorktree: { undefined: 'asWritten', empty: 'keep' },
  clientHostedBrowserPagesByWorktree: { undefined: 'prior', empty: 'keep' },
  clientHostedBrowserCloseIntentsByEnvironment: { undefined: 'asWritten', empty: 'keep' },
  pairedTerminalTabCloseIntentsByEnvironment: { undefined: 'asWritten', empty: 'keep' },
  activeTabTypeByWorktree: { undefined: 'asWritten', empty: 'keep' },
  activeTabIdByWorktree: { undefined: 'asWritten', empty: 'keep' },
  unifiedTabs: { undefined: 'asWritten', empty: 'keep' },
  tabGroups: { undefined: 'asWritten', empty: 'keep' },
  tabGroupLayouts: { undefined: 'asWritten', empty: 'keep' },
  activeGroupIdByWorktree: { undefined: 'asWritten', empty: 'keep' },
  remoteSessionIdsByTabId: { undefined: 'asWritten', empty: 'keep' },
  lastVisitedAtByWorktreeId: { undefined: 'asWritten', empty: 'keep' },
  defaultTerminalTabsAppliedByWorktreeId: { undefined: 'asWritten', empty: 'keep' },
  sleepingAgentSessionsByPaneKey: { undefined: 'asWritten', empty: 'omit' },
  terminalPtyIncarnationsByPaneKey: { undefined: 'asWritten', empty: 'omit' },
  terminalTopologyRevisionByRepoId: { undefined: 'asWritten', empty: 'keep' },
  terminalSurfaceTombstonesByPaneKey: { undefined: 'asWritten', empty: 'keep' },
  closedTerminalTabTombstonesByTabId: { undefined: 'prior', empty: 'omit' },
  closedTerminalPanesByPaneKey: { undefined: 'asWritten', empty: 'keep' }
} as const satisfies Record<
  SessionMapField,
  { undefined: 'empty' | 'prior' | 'asWritten'; empty: 'omit' | 'keep' }
>

export type SessionFieldPresenceIntent = {
  kind: 'unmentioned' | 'entries' | 'output' | 'replacement' | 'rollback'
  present: boolean
  explicitEmpty?: boolean
  valueWhenEmpty?: 'undefined'
}

/** Field presence follows operation intent and complete cardinality, never selected output size. */
export function sessionFieldIsPresent(
  field: SessionMapField,
  intent: SessionFieldPresenceIntent,
  entries: number
): boolean {
  if (intent.kind === 'unmentioned' || intent.kind === 'rollback') {
    return intent.present
  }
  if (entries > 0) {
    return true
  }
  if (SESSION_FIELD_POLICY[field].undefined === 'empty') {
    return true
  }
  if (intent.explicitEmpty) {
    return true
  }
  if (intent.kind === 'replacement') {
    return intent.present
  }
  if (intent.kind === 'output') {
    return intent.present && SESSION_FIELD_POLICY[field].empty === 'keep'
  }
  return intent.present && SESSION_FIELD_POLICY[field].empty === 'keep'
}

export type SessionMapField = (typeof SESSION_MAP_FIELDS)[number]
export type SessionMembershipField = 'activeWorktreeIdsOnShutdown' | 'activeConnectionIdsAtShutdown'
export type SessionMapDeltas = {
  [F in SessionMapField]?: {
    set?: NonNullable<WorkspaceSessionState[F]>
    remove?: readonly string[]
  }
}
export type SessionPatchEnvelope = {
  mapDeltas?: SessionMapDeltas
  membershipDeltas?: Partial<
    Record<
      SessionMembershipField,
      {
        add?: readonly string[]
        remove?: readonly string[]
      }
    >
  >
  clearFields?: readonly (keyof WorkspaceSessionState)[]
  expectedPartitionGeneration?: string
}
export type SessionPatchAck = {
  applied: boolean
  partitionGeneration: string
  reason?: 'fenced' | 'generationChanged'
}
export type SessionAdmissionKind = 'renderer' | 'authoritative' | 'rollback' | 'fullReplacement'
export type SessionUnitChange = (
  | { field: SessionMapField; key: string }
  | { field: keyof WorkspaceSessionState; key: null }
) & {
  prior: unknown
  next: unknown
  priorPresent: boolean
  nextPresent: boolean
}
export type SessionChangeSet = {
  hostId: ExecutionHostId
  kind: SessionAdmissionKind
  generation: number
  fullReplacement: boolean
  editorViews?: ReadonlyMap<string, { prior: unknown; next: unknown }>
  units: readonly SessionUnitChange[]
  owners: ReadonlySet<string>
  tabs: ReadonlySet<string>
  panes: ReadonlySet<string>
  files: ReadonlySet<string>
  pages: ReadonlySet<string>
  repos: ReadonlySet<string>
}

export function isSessionMapField(field: string): field is SessionMapField {
  return SESSION_MAP_FIELDS.some((candidate) => candidate === field)
}

export function sessionMap(
  session: Partial<WorkspaceSessionState>,
  field: SessionMapField
): Readonly<Record<string, unknown>> | undefined {
  return session[field]
}

export function applySessionMapDeltas(
  prior: WorkspaceSessionState,
  deltas: SessionMapDeltas
): WorkspaceSessionState {
  const next = { ...prior }
  for (const field of SESSION_MAP_FIELDS) {
    const delta = deltas[field]
    if (!delta || (!Object.keys(delta.set ?? {}).length && !delta.remove?.length)) {
      continue
    }
    Object.assign(next, {
      [field]: copySessionRecord(sessionMap(prior, field), delta.set, delta.remove)
    })
  }
  return next
}
