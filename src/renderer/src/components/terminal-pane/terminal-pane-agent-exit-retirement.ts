import { useAppStore } from '../../store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveChatPairAuthority } from '@/store/slices/tabs/terminal-chat-pair-authority'
import { readHostPresentationTokenAt } from '@/runtime/host-presentation-token-history'
import type { AgentExitObservationOrigin } from '../../../../shared/agent-exit-retirement'

/**
 * A mounted pane's confirmed agent exit on a host that owns exits (this desktop, or a paired host
 * advertising it): only that pane's chat turns terminal, fenced by when the exit was observed, and
 * chat never moves to a sibling. False when the host predates this, so the caller keeps its route.
 */
export function retirePaneChatForObservedAgentExit(args: {
  worktreeId: string
  tabId: string
  leafId: string
  origin: AgentExitObservationOrigin | undefined
}): boolean {
  const state = useAppStore.getState()
  const authority = resolveChatPairAuthority(state, args.worktreeId)
  if (authority === 'local') {
    state.retireTerminalChatForAgentExit(args.tabId, {
      leafId: args.leafId,
      ...(args.origin?.ptyId ? { ptyId: args.origin.ptyId } : {}),
      ...(args.origin ? { observedAtMs: args.origin.observedAtMs } : {})
    })
    return true
  }
  // Why never "now": a delayed exit must not adopt a token the host published after it.
  const observedAtMs = args.origin?.observedAtMs ?? 0
  if (
    authority !== 'host' ||
    state.chatViewAgentExitHostOwnedByWorktree?.[args.worktreeId] !== true
  ) {
    return false
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, args.worktreeId)
  if (!environmentId) {
    // Why: never swallow an exit; the caller's route still turns this pane terminal.
    return false
  }
  void import('@/runtime/web-runtime-chat-pair-write')
    .then(({ resolveWebRuntimeHostTabId, retireWebRuntimeAgentExitChat }) => {
      const hostTabId = resolveWebRuntimeHostTabId(useAppStore.getState(), environmentId, {
        worktreeId: args.worktreeId,
        terminalTabId: args.tabId
      })
      // Why: no token held (e.g. none published yet) still asks the host; it then retires only
      // while this leaf owns chat, never moving chat or overriding another pane.
      const presentationToken = readHostPresentationTokenAt(
        { worktreeId: args.worktreeId, hostTabId, leafId: args.leafId },
        observedAtMs
      )
      return retireWebRuntimeAgentExitChat({
        worktreeId: args.worktreeId,
        terminalTabId: args.tabId,
        leafId: args.leafId,
        presentationToken
      })
    })
    .catch((error: unknown) => {
      console.warn(
        '[native-chat] could not ask the host to retire an exited agent chat view',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
