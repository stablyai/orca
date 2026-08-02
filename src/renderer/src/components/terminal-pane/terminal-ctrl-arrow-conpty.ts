import type { ExecutionHostId } from '../../../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { isLocalNativeWindowsConpty } from '@/lib/pane-manager/windows-pty-compatibility'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { PtyTransport } from './pty-transport-types'

const REMOTE_RUNTIME_PTY_ID_PREFIX = 'remote:'

type TerminalTabShellState = {
  tabsByWorktree: Record<
    string,
    readonly { id: string; shellOverride?: string | null }[] | undefined
  >
}

export type TerminalCtrlArrowConptyState = Parameters<typeof getConnectionIdFromState>[0] &
  WorktreeRuntimeOwnerState &
  TerminalTabShellState

type TerminalCtrlArrowConptyTransport = Pick<
  PtyTransport,
  'getPtyId' | 'getConnectionId' | 'getLocalSessionMetadata'
>

type TerminalCtrlArrowConptyArgs = {
  isWindows: boolean
  userAgent: string
  state: TerminalCtrlArrowConptyState
  worktreeId: string
  tabId: string
  paneId: number
  paneCwd: PaneCwdMap
  fallbackCwd: string
  transport: TerminalCtrlArrowConptyTransport | null
}

function isRemoteRuntimePtyId(ptyId: string): boolean {
  return ptyId.startsWith(REMOTE_RUNTIME_PTY_ID_PREFIX)
}

export function isLocalWindowsConptyPaneForCtrlArrow({
  isWindows,
  userAgent,
  state,
  worktreeId,
  tabId,
  paneId,
  paneCwd,
  fallbackCwd,
  transport
}: TerminalCtrlArrowConptyArgs): boolean {
  if (!isWindows) {
    return false
  }

  const ptyId = transport?.getPtyId() ?? null
  if (ptyId !== null && isRemoteRuntimePtyId(ptyId)) {
    return false
  }

  const sessionMetadata = transport?.getLocalSessionMetadata?.()
  const hasLiveLocalSession =
    ptyId !== null && sessionMetadata !== null && sessionMetadata !== undefined
  const transportConnectionId = transport?.getConnectionId?.()
  const connectionId = hasLiveLocalSession
    ? null
    : transportConnectionId === undefined
      ? getConnectionIdFromState(state, worktreeId)
      : transportConnectionId
  const tabShellOverride = state.tabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === tabId
  )?.shellOverride
  const executionHostId: ExecutionHostId = hasLiveLocalSession
    ? LOCAL_EXECUTION_HOST_ID
    : getExecutionHostIdForWorktree(state, worktreeId)

  return isLocalNativeWindowsConpty({
    userAgent,
    connectionId,
    cwd: sessionMetadata?.cwd ?? paneCwd.get(paneId)?.cwd ?? fallbackCwd,
    shellOverride: sessionMetadata?.shellOverride ?? tabShellOverride,
    executionHostId
  })
}
