import { parseExecutionHostId } from '../../../../shared/execution-host'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getExecutionHostIdForWorktree,
  runtimeEnvironmentIdOrLocalUnlessTwin
} from '@/lib/worktree-runtime-owner'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import type { AppState } from '@/store/types'
import type { PtyTransport } from './pty-transport-types'
import { isWslShellOverride } from './terminal-paste-runtime'
import { runtimeHostPlatform, sshTargetRemotePlatform } from './pty-owner-machine-platform'

type TerminalInputHostPlatformState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'settings'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
  | 'runtimeStatusByEnvironmentId'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export function resolveTerminalInputHostPlatform(args: {
  clientPlatform: NodeJS.Platform
  state: TerminalInputHostPlatformState
  worktreeId: string
  transport:
    | (Pick<PtyTransport, 'getConnectionId'> &
        Partial<
          Pick<
            PtyTransport,
            | 'getPtyId'
            | 'getRuntimeEnvironmentId'
            | 'getExecutionHostId'
            | 'getRemotePlatform'
            | 'getLocalSessionMetadata'
          >
        >)
    | null
}): NodeJS.Platform {
  const authoritativePlatform = args.transport?.getRemotePlatform?.()
  if (authoritativePlatform) {
    return authoritativePlatform
  }
  const transportConnectionId = args.transport?.getConnectionId?.()
  const connectionId =
    transportConnectionId === undefined
      ? getConnectionIdFromState(args.state, args.worktreeId)
      : transportConnectionId
  if (connectionId) {
    // Why: only an SSH-owner report may enable Windows-specific input encoding; client OS is unrelated.
    return sshTargetRemotePlatform(args.state, connectionId, null) ?? 'linux'
  }

  // The live binding retains its spawn-time runtime even if workspace host selection changes.
  const ptyId = args.transport?.getPtyId?.() ?? null
  const runtimeEnvironmentId =
    args.transport?.getRuntimeEnvironmentId?.() ??
    (ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null)
  const transportExecutionHost = parseExecutionHostId(args.transport?.getExecutionHostId?.())
  if (runtimeEnvironmentId && transportExecutionHost?.kind === 'ssh') {
    return (
      sshTargetRemotePlatform(args.state, transportExecutionHost.targetId, runtimeEnvironmentId) ??
      'linux'
    )
  }
  if (runtimeEnvironmentId) {
    return runtimeHostPlatform(args.state, runtimeEnvironmentId) ?? args.clientPlatform
  }
  const localSessionMetadata = args.transport?.getLocalSessionMetadata?.()
  if (ptyId !== null && localSessionMetadata != null) {
    const isWslSession =
      isWslUncPath(localSessionMetadata.cwd ?? '') ||
      isWslShellOverride(localSessionMetadata.shellOverride)
    return args.clientPlatform === 'win32' && isWslSession ? 'linux' : args.clientPlatform
  }

  const host = parseExecutionHostId(getExecutionHostIdForWorktree(args.state, args.worktreeId))
  if (host?.kind === 'ssh') {
    const ownerEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(args.state, args.worktreeId)
    return sshTargetRemotePlatform(args.state, host.targetId, ownerEnvironmentId) ?? 'linux'
  }
  if (host?.kind === 'runtime') {
    return runtimeHostPlatform(args.state, host.environmentId) ?? args.clientPlatform
  }
  return args.clientPlatform
}
