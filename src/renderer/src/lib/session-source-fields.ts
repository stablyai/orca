import type { AppState } from '../store/types'
import type { OpenFile } from '../store/slices/editor'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'

export const SESSION_ROUTING_FIELDS = [
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'hydratedRuntimeSessionHostIds',
  'contestedPrimaryHostBySessionKey',
  'contestedHostWorkspaceSessions'
] as const satisfies readonly (keyof AppState)[]
export const SESSION_SOURCE_FIELDS = [
  ...SESSION_RELEVANT_FIELDS,
  ...SESSION_ROUTING_FIELDS
] as const
export type SessionSourceField = (typeof SESSION_SOURCE_FIELDS)[number]
export const SESSION_SOURCE_KINDS = {
  activeRepoId: 'field',
  activeWorkspaceKey: 'field',
  activeWorkspaceExecutionHostId: 'field',
  activeWorktreeId: 'field',
  activeTabId: 'field',
  tabsByWorktree: 'keyed',
  ptyIdsByTabId: 'keyed',
  terminalLayoutsByTabId: 'keyed',
  localOnlyScrollbackByTabId: 'keyed',
  activeTabIdByWorktree: 'keyed',
  openFiles: 'sequence',
  editorDrafts: 'keyed',
  markdownFrontmatterVisible: 'keyed',
  activeFileIdByWorktree: 'keyed',
  activeTabTypeByWorktree: 'keyed',
  browserTabsByWorktree: 'keyed',
  browserPagesByWorkspace: 'keyed',
  activeBrowserTabIdByWorktree: 'keyed',
  browserUrlHistory: 'field',
  workspaceDocHistory: 'field',
  remoteBrowserPageHandlesByPageId: 'keyed',
  unifiedTabsByWorktree: 'keyed',
  groupsByWorktree: 'keyed',
  layoutByWorktree: 'keyed',
  activeGroupIdByWorktree: 'keyed',
  sshConnectionStates: 'keyed',
  repos: 'sequence',
  worktreesByRepo: 'keyed',
  lastKnownRelayPtyIdByTabId: 'keyed',
  lastVisitedAtByWorktreeId: 'keyed',
  defaultTerminalTabsAppliedByWorktreeId: 'keyed',
  sleepingAgentSessionsByPaneKey: 'keyed',
  clientHostedBrowserCloseIntentsByEnvironment: 'keyed',
  pairedTerminalTabCloseIntentsByEnvironment: 'keyed',
  pendingReconnectPtyIdByTabId: 'keyed',
  deferredSshSessionIdsByTabId: 'keyed',
  folderWorkspaces: 'sequence',
  projectGroups: 'sequence',
  restoredRuntimeHostIdByWorkspaceSessionKey: 'keyed',
  hydratedRuntimeSessionHostIds: 'field',
  contestedPrimaryHostBySessionKey: 'keyed',
  contestedHostWorkspaceSessions: 'field'
} as const satisfies Record<SessionSourceField, 'field' | 'keyed' | 'sequence'>
export type SessionSourceKind<K extends 'field' | 'keyed' | 'sequence'> = {
  [F in SessionSourceField]: (typeof SESSION_SOURCE_KINDS)[F] extends K ? F : never
}[SessionSourceField]
export type SessionSequenceField = SessionSourceKind<'sequence'>
export type SessionSourceSequences = {
  [F in SessionSequenceField]?: ReadonlyMap<string, AppState[F]>
}
export type SessionSourcePresence = { before: boolean; after: boolean }
export type SessionMutation = ReadonlyMap<SessionSourceField, ReadonlySet<string> | null>
export type SessionSourceDiscovery = {
  changes: SessionMutation
  full: boolean
  fullBoundary?: 'replacement' | 'order' | 'fallback'
  sequences?: SessionSourceSequences
  presence?: ReadonlyMap<SessionSourceField, ReadonlyMap<string, SessionSourcePresence>>
}

export function groupSessionFiles(
  files: readonly OpenFile[],
  owners?: ReadonlySet<string>
): Map<string, OpenFile[]> {
  const groups = new Map<string, OpenFile[]>()
  for (const file of files) {
    if (owners && !owners.has(file.worktreeId)) {
      continue
    }
    const rows = groups.get(file.worktreeId)
    if (rows) {
      rows.push(file)
    } else {
      groups.set(file.worktreeId, [file])
    }
  }
  return groups
}

export function groupSessionCatalog<T extends { id: string }>(
  rows: readonly T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const entries = groups.get(row.id)
    if (entries) {
      entries.push(row)
    } else {
      groups.set(row.id, [row])
    }
  }
  return groups
}
