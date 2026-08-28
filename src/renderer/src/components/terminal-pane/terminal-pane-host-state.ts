import type { AppState } from '@/store/types'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import {
  selectRuntimeAwareSshError,
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel,
  selectRuntimeAwareSshTargetRemoved
} from '@/store/slices/runtime-environment-ssh'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'

export type TerminalPaneHostState = {
  nativeChatTranscriptIsLocalReadable: boolean
  sshReconnectEnvironmentId: string | null
  /** The failure detail behind the status; the overlay shows only a canned sentence without it. */
  sshReconnectError: string | null
  sshReconnectStatus: ReturnType<typeof selectRuntimeAwareSshStatus>
  sshReconnectTargetId: string | null
  sshReconnectTargetLabel: string
  sshReconnectTargetRemoved: boolean
}

export function selectTerminalPaneHostState(
  state: AppState,
  worktreeId: string
): TerminalPaneHostState {
  const connectionId = getConnectionIdFromState(state, worktreeId)
  const nativeChatTranscriptIsLocalReadableResult =
    isNativeChatTranscriptLocalReadable(connectionId)
  const sshReconnectTargetId =
    connectionId && !isRuntimeOwnedSshTargetId(connectionId) ? connectionId : null
  if (!sshReconnectTargetId) {
    return {
      nativeChatTranscriptIsLocalReadable: nativeChatTranscriptIsLocalReadableResult,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: null,
      sshReconnectTargetId: null,
      sshReconnectTargetLabel: '',
      sshReconnectTargetRemoved: false
    }
  }
  const sshReconnectEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return {
    nativeChatTranscriptIsLocalReadable: nativeChatTranscriptIsLocalReadableResult,
    sshReconnectEnvironmentId,
    sshReconnectError: selectRuntimeAwareSshError(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId
    ),
    sshReconnectStatus: selectRuntimeAwareSshStatus(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId
    ),
    sshReconnectTargetId,
    sshReconnectTargetLabel: selectRuntimeAwareSshTargetLabel(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId
    ),
    sshReconnectTargetRemoved: selectRuntimeAwareSshTargetRemoved(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId
    )
  }
}
