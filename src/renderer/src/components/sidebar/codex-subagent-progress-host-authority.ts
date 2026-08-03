import type { AppState } from '@/store/types'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

export type CodexSubagentProgressHostAuthority =
  | { kind: 'local' }
  | { kind: 'runtime'; environmentId: string }
  | { kind: 'legacy-ssh' }
  | { kind: 'unknown'; reason: 'unknown-owner' | 'runtime-owner-missing' }

export type CodexSubagentProgressHostAuthorityState = WorktreeRuntimeOwnerState &
  Pick<AppState, 'terminalLayoutsByTabId'>

export function resolveCodexSubagentProgressHostAuthority(args: {
  connectionId: string | null | undefined
  explicitRuntimeEnvironmentId: string | null
  ptyId: string | null | undefined
}): CodexSubagentProgressHostAuthority {
  if (args.connectionId === undefined) {
    return { kind: 'unknown', reason: 'unknown-owner' }
  }
  const runtimeOwnedConnection = isRuntimeOwnedSshTargetId(args.connectionId)
  if (typeof args.connectionId === 'string' && !runtimeOwnedConnection) {
    return { kind: 'legacy-ssh' }
  }

  const explicitRuntimeEnvironmentId = args.explicitRuntimeEnvironmentId?.trim() || null
  const ptyId = args.ptyId?.trim() || null
  if (ptyId?.startsWith('remote:')) {
    const remotePty = parseRemoteRuntimePtyId(ptyId)
    if (!remotePty) {
      return { kind: 'unknown', reason: 'unknown-owner' }
    }
    if (
      remotePty.environmentId &&
      explicitRuntimeEnvironmentId &&
      remotePty.environmentId !== explicitRuntimeEnvironmentId
    ) {
      return { kind: 'unknown', reason: 'unknown-owner' }
    }
    const environmentId = remotePty.environmentId ?? explicitRuntimeEnvironmentId
    return environmentId
      ? { kind: 'runtime', environmentId }
      : { kind: 'unknown', reason: 'runtime-owner-missing' }
  }
  const sshPty = ptyId ? parseAppSshPtyId(ptyId) : null
  if (sshPty) {
    return runtimeOwnedConnection &&
      sshPty.connectionId === args.connectionId &&
      explicitRuntimeEnvironmentId
      ? { kind: 'runtime', environmentId: explicitRuntimeEnvironmentId }
      : {
          kind: 'unknown',
          reason: runtimeOwnedConnection ? 'runtime-owner-missing' : 'unknown-owner'
        }
  }
  if (ptyId?.startsWith('ssh:')) {
    return { kind: 'unknown', reason: 'unknown-owner' }
  }
  if (ptyId) {
    if (explicitRuntimeEnvironmentId || runtimeOwnedConnection) {
      return { kind: 'unknown', reason: 'unknown-owner' }
    }
    return { kind: 'local' }
  }
  if (explicitRuntimeEnvironmentId) {
    return { kind: 'runtime', environmentId: explicitRuntimeEnvironmentId }
  }
  return {
    kind: 'unknown',
    reason: runtimeOwnedConnection ? 'runtime-owner-missing' : 'unknown-owner'
  }
}

export function selectCodexSubagentProgressHostAuthority(
  state: CodexSubagentProgressHostAuthorityState,
  args: {
    worktreeId: string
    parentPaneKey: string
    tabPtyId: string | null | undefined
    connectionId: string | null | undefined
  }
): CodexSubagentProgressHostAuthority {
  const pane = parsePaneKey(args.parentPaneKey)
  const panePtyId = pane
    ? state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
    : undefined
  return resolveCodexSubagentProgressHostAuthority({
    connectionId: args.connectionId,
    explicitRuntimeEnvironmentId: getExplicitRuntimeEnvironmentIdForWorktree(
      state,
      args.worktreeId
    ),
    ptyId: panePtyId ?? args.tabPtyId
  })
}
