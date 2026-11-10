import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { AppState } from '../types'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import {
  resolveTerminalPtyOwner,
  type TerminalPtyOwner
} from '@/lib/workspace/ownership/terminal-worktree-route'

export type TerminalTabRetirementState = WorktreeRuntimeOwnerState &
  Pick<
    AppState,
    | 'tabsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'ptyIdsByTabId'
    | 'terminalLayoutsByTabId'
    | 'lastKnownRelayPtyIdByTabId'
    | 'deferredSshSessionIdsByTabId'
    | 'pendingReconnectPtyIdByTabId'
  >

function appendPtyId(ids: Set<string>, ptyId: string | null | undefined): void {
  if (ptyId) {
    ids.add(ptyId)
  }
}

export function getTerminalPtyOwnershipIdentity(
  state: TerminalTabRetirementState,
  ptyId: string,
  worktreeId: string | null
): string {
  const remote = parseRemoteRuntimePtyId(ptyId)
  if (!remote?.handle) {
    return `pty:${ptyId}`
  }
  const scopedEnvironmentId = remote.environmentId?.trim()
  if (scopedEnvironmentId) {
    return JSON.stringify(['runtime', scopedEnvironmentId, remote.handle])
  }
  // Resolve legacy/scoped PTY aliases on the owner used by spawn/close so identity and retirement agree.
  return terminalPtyIdentityForOwner(ptyId, resolveTerminalPtyOwner(state, worktreeId, 'spawn'))
}

export function terminalPtyIdentityForOwner(ptyId: string, owner: TerminalPtyOwner): string {
  const remote = parseRemoteRuntimePtyId(ptyId)
  if (!remote?.handle) {
    return `pty:${ptyId}`
  }
  const environment = remote.environmentId?.trim()
  if (environment) {
    return JSON.stringify(['runtime', environment, remote.handle])
  }
  // Why: a twin's legacy id can't be pinned to either host, so it matches only its own exact id.
  if (owner.kind === 'ambiguous') {
    return `pty:${ptyId}`
  }
  const environmentId = owner.kind === 'runtime' ? owner.environmentId : ''
  return JSON.stringify(['runtime', environmentId, remote.handle])
}

export function collectPtyIdsForTab(
  state: TerminalTabRetirementState,
  tabId: string,
  rowPtyId: string | null | undefined
): string[] {
  const ids = new Set<string>()
  for (const ptyId of state.ptyIdsByTabId[tabId] ?? []) {
    appendPtyId(ids, ptyId)
  }
  appendPtyId(ids, rowPtyId)
  for (const ptyId of Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})) {
    appendPtyId(ids, ptyId)
  }
  appendPtyId(ids, state.lastKnownRelayPtyIdByTabId[tabId])
  appendPtyId(ids, state.deferredSshSessionIdsByTabId[tabId])
  appendPtyId(ids, state.pendingReconnectPtyIdByTabId[tabId])
  return [...ids]
}
