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

function computeTerminalPaneHostState(state: AppState, worktreeId: string): TerminalPaneHostState {
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

function isSameHostState(a: TerminalPaneHostState, b: TerminalPaneHostState): boolean {
  return (
    a.nativeChatTranscriptIsLocalReadable === b.nativeChatTranscriptIsLocalReadable &&
    a.sshReconnectEnvironmentId === b.sshReconnectEnvironmentId &&
    a.sshReconnectError === b.sshReconnectError &&
    a.sshReconnectStatus === b.sshReconnectStatus &&
    a.sshReconnectTargetId === b.sshReconnectTargetId &&
    a.sshReconnectTargetLabel === b.sshReconnectTargetLabel &&
    a.sshReconnectTargetRemoved === b.sshReconnectTargetRemoved
  )
}

let cachedState: AppState | null = null
let cachedByWorktreeId = new Map<string, TerminalPaneHostState>()
let previousByWorktreeId = new Map<string, TerminalPaneHostState>()

/**
 * Per-worktree memo of the host state one TerminalPane needs.
 *
 * Why keyed on the whole `state` object and nothing narrower: resolving the
 * execution host walks repos, worktree owners, folder-workspace routes, and the
 * runtime/SSH slices, so no hand-written input list can be shown to be complete
 * — and an incomplete one would hand an SSH pane a stale host. Zustand mints a
 * new state object for every publication, so state identity is an exact,
 * conservative key: a write can never be missed, and within one published state
 * every mounted tab of a worktree resolves the host once instead of once each.
 *
 * The previous result is returned when nothing changed, so the shallow-equal
 * subscriber compares by identity and the selector stops allocating per publication.
 */
export function selectTerminalPaneHostState(
  state: AppState,
  worktreeId: string
): TerminalPaneHostState {
  if (state !== cachedState) {
    previousByWorktreeId = cachedByWorktreeId
    cachedByWorktreeId = new Map()
    cachedState = state
  }
  const cached = cachedByWorktreeId.get(worktreeId)
  if (cached) {
    return cached
  }
  const next = computeTerminalPaneHostState(state, worktreeId)
  const previous = previousByWorktreeId.get(worktreeId)
  const result = previous && isSameHostState(previous, next) ? previous : next
  cachedByWorktreeId.set(worktreeId, result)
  return result
}

/** Test seam: drops the memo so a suite can measure a cold resolve. */
export function resetTerminalPaneHostStateMemoForTests(): void {
  cachedState = null
  cachedByWorktreeId = new Map()
  previousByWorktreeId = new Map()
}
