// Reload a few workspaces with the unchanged Loader over a slice of their partition. The Loader ties workspaces only through shared rows, pane ids, terminals and worktree ids; a slice holding every workspace that shares one of those loads them as the whole partition would.

import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../terminal-topology/terminal-pane-tree'
import { paneKeyOf, type WorkspaceLayout } from '../workspace-layout-model'
import { CARRIED_SESSION_FIELDS, FACT_SESSION_FIELDS } from './workspace-layout-beside'
import { resolveWorktreeId } from './workspace-layout-load-records'

/** The workspace-keyed maps, in the order that sets partition order (workspaceKeys). */
const WORKSPACE_FIELDS = [
  'tabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'openFilesByWorktree',
  'browserTabsByWorktree'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/** Which workspace-keyed maps hold the key; a change can move it in partition order. */
export function workspaceMembership(session: WorkspaceSessionState, key: string): number {
  let mask = 0
  WORKSPACE_FIELDS.forEach((field, bit) => {
    const map = session[field]
    if (map && Object.hasOwn(map, key)) {
      mask |= 1 << bit
    }
  })
  return mask
}

export type StoredShareRefs = { refs: Set<string>; worktreeId: string }

export const rowShareRef = (rowId: string): string => `row:${rowId}`
export const leafShareRef = (leafId: string): string => `leaf:${leafId}`
export const worktreeShareRef = (worktreeId: string): string => `worktree:${worktreeId}`

/**
 * Refs the Loader's cross-workspace passes compare: rows (terminal homes), pane ids (reminting), terminals
 * (duplicate unbinding) and the resolved worktree id (closed tabs). Null for a row saved before pane
 * layouts: its pane id comes from partition-wide records.
 */
export function storedShareRefs(
  session: WorkspaceSessionState,
  key: string
): StoredShareRefs | null {
  const worktreeId = resolveWorktreeId({ session, key })
  const refs = new Set([worktreeShareRef(worktreeId)])
  for (const row of session.tabsByWorktree?.[key] ?? []) {
    const layout = session.terminalLayoutsByTabId?.[row.id]
    if (!layout) {
      return null
    }
    refs.add(rowShareRef(row.id))
    if (row.ptyId) {
      refs.add(`pty:${row.ptyId}`)
    }
    for (const leafId of collectLayoutLeafIdsInOrder(layout.root ?? null)) {
      refs.add(leafShareRef(leafId))
    }
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      if (ptyId) {
        refs.add(`pty:${ptyId}`)
      }
    }
  }
  return { refs, worktreeId }
}

/** A loaded workspace's pane ids, minted ones included: a later workspace's repeat of one is reminted. */
export function loadedShareRefs(workspace: WorkspaceLayout): string[] {
  return [
    worktreeShareRef(workspace.worktreeId),
    ...workspace.tabs.flatMap((tab) =>
      tab.kind === 'terminal' ? collectLayoutLeafIdsInOrder(tab.panes.root).map(leafShareRef) : []
    )
  ]
}

/** Raw row and pane ids a share ref names, for clearing a reloaded workspace's beside entries. */
export function sharedRowOf(ref: string): string | null {
  return ref.startsWith('row:') ? ref.slice('row:'.length) : null
}

export function sharedLeafOf(ref: string): string | null {
  return ref.startsWith('leaf:') ? ref.slice('leaf:'.length) : null
}

function pick<T>(
  record: Record<string, T> | undefined,
  keys: Iterable<string>
): Record<string, T> | undefined {
  if (!record) {
    return undefined
  }
  const picked: Record<string, T> = {}
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      Object.defineProperty(picked, key, {
        value: record[key],
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
  }
  return picked
}

/**
 * The keys' own entries (keys in partition order) and the records their rows, panes and worktree ids name.
 * Partition-wide view fields pass through; carried and fact fields, which partition readers never use, are left out.
 * Callers rule out legacy surface tombstones.
 */
export function sliceWorkspaceSession(
  session: WorkspaceSessionState,
  keys: readonly string[],
  worktreeIds: ReadonlySet<string>
): WorkspaceSessionState {
  const slice: WorkspaceSessionState = { ...session }
  for (const field of [...CARRIED_SESSION_FIELDS, ...FACT_SESSION_FIELDS]) {
    delete slice[field]
  }
  for (const field of WORKSPACE_FIELDS) {
    const picked = pick<unknown>(session[field], keys)
    if (picked) {
      Object.assign(slice, { [field]: picked })
    }
  }
  const rowIds: string[] = []
  const paneKeys: string[] = []
  for (const key of keys) {
    for (const row of session.tabsByWorktree?.[key] ?? []) {
      rowIds.push(row.id)
      const layout = session.terminalLayoutsByTabId?.[row.id]
      for (const leafId of collectLayoutLeafIdsInOrder(layout?.root ?? null)) {
        paneKeys.push(paneKeyOf(row.id, leafId))
      }
    }
  }
  slice.terminalLayoutsByTabId = pick(session.terminalLayoutsByTabId, rowIds) ?? {}
  // Read per row to resolve which rows a tab-bar terminal subsumes.
  const remoteSessions = pick(session.remoteSessionIdsByTabId, rowIds)
  if (remoteSessions) {
    slice.remoteSessionIdsByTabId = remoteSessions
  }
  const sleeping = pick(session.sleepingAgentSessionsByPaneKey, paneKeys)
  const incarnations = pick(session.terminalPtyIncarnationsByPaneKey, paneKeys)
  const closed = session.closedTerminalTabTombstonesByTabId
  if (sleeping) {
    slice.sleepingAgentSessionsByPaneKey = sleeping
  }
  if (incarnations) {
    slice.terminalPtyIncarnationsByPaneKey = incarnations
  }
  if (closed) {
    // Capped per partition (MAX_CLOSED_TERMINAL_TAB_TOMBSTONES), so this stays small.
    slice.closedTerminalTabTombstonesByTabId = pick(
      closed,
      Object.keys(closed).filter((tabId) => worktreeIds.has(closed[tabId]!.worktreeId))
    )
  }
  delete slice.terminalSurfaceTombstonesByPaneKey
  return slice
}
