import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { PtyTransport } from './pty-transport-types'

type TerminalInputHostPlatformState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'settings'
  | 'sshConnectionStates'
  | 'runtimeStatusByEnvironmentId'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export function resolveTerminalInputHostPlatform(args: {
  clientPlatform: NodeJS.Platform
  state: TerminalInputHostPlatformState
  worktreeId: string
  transport: Pick<PtyTransport, 'getConnectionId'> | null
}): NodeJS.Platform {
  const transportConnectionId = args.transport?.getConnectionId?.()
  const connectionId =
    transportConnectionId === undefined
      ? getConnectionIdFromState(args.state, args.worktreeId)
      : transportConnectionId
  if (connectionId) {
    return args.state.sshConnectionStates.get(connectionId)?.remotePlatform ?? args.clientPlatform
  }

  const host = parseExecutionHostId(getExecutionHostIdForWorktree(args.state, args.worktreeId))
  if (host?.kind === 'runtime') {
    return (
      args.state.runtimeStatusByEnvironmentId.get(host.environmentId)?.status?.hostPlatform ??
      args.clientPlatform
    )
  }
  return args.clientPlatform
}
