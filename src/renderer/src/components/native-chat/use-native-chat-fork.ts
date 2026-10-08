import { useCallback, useMemo } from 'react'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionHostCapability } from '@/runtime/structured-agent-session-host-capability'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { AGENT_SESSION_FORK_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { selectStructuredAgentForkRows } from '../../../../shared/structured-agent-session-fork-rows'

export type NativeChatForkSurface = {
  rows: ReadonlySet<string>
  /** Open a new chat holding the conversation through the turn `itemId` belongs to. */
  fork: (itemId: string) => void
}

/**
 * "Fork from this turn" for a structured chat, or undefined where it cannot be offered: the host
 * predates it, the agent has no provider fork, or the chat's workspace is not known yet.
 */
export function useNativeChatFork(
  pane: { sessionId: string; target: RuntimeClientTarget; agent: string },
  worktreeId: string | null | undefined,
  items: readonly AgentJournalRenderItem[]
): NativeChatForkSurface | undefined {
  const hostForks = useStructuredAgentSessionHostCapability(
    pane.target,
    AGENT_SESSION_FORK_RUNTIME_CAPABILITY
  )
  const { sessionId, agent, target } = pane
  const offered = hostForks && Boolean(worktreeId) && isAgentSessionHandleProvider(agent)
  const rows = useMemo(
    () => (offered ? selectStructuredAgentForkRows(agent, items) : null),
    [agent, items, offered]
  )
  const fork = useCallback(
    (itemId: string) => {
      if (!worktreeId || !isAgentSessionHandleProvider(agent)) {
        return
      }
      // The parent's own host: only it holds the chat to copy. A start that fails is reported by
      // the new chat's tab, as for any other chat.
      beginStructuredAgentSessionProvisionalLaunch({
        plan: adoptAgentSessionLaunchVerdict({
          route: 'structured-native-chat',
          requestId: newAgentLaunchRequestId(),
          agent,
          worktreeId,
          executionHostId: executionHostIdForStructuredTarget(target),
          forkFrom: { sessionId, itemId }
        }),
        hooks: {}
      })
    },
    [agent, sessionId, target, worktreeId]
  )
  return useMemo(() => (rows ? { rows, fork } : undefined), [fork, rows])
}
