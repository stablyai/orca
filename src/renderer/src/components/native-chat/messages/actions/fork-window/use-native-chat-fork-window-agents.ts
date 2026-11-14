import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { detectAgentSessionContinuationAgents } from '@/lib/agent-session/launch/continuation/launch-agent-session-continuation'
import { chatProviderAgents } from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { isTuiAgentEnabled } from '../../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'

export type NativeChatForkAgents = {
  /** The chat's own agent first, then the enabled agents the workspace's host can start. */
  agents: TuiAgent[]
  /** The agents that open as a chat there; null until detection answers. */
  chatAgents: readonly TuiAgent[] | null
  /** The agents whose CLI the host found; null until detection answers. */
  cliAgents: readonly TuiAgent[] | null
  detecting: boolean
}

type Found = { worktreeId: string; cli: readonly TuiAgent[]; chat: readonly TuiAgent[] }

/** Agents a fork into `worktreeId` can start; only the chat's own agent until detection answers. */
export function useNativeChatForkAgents(
  worktreeId: string | null,
  sourceAgent: TuiAgent
): NativeChatForkAgents {
  const disabled = useAppStore((state) => state.settings?.disabledTuiAgents)
  const [found, setFound] = useState<Found | null>(null)
  useEffect(() => {
    if (!worktreeId) {
      return
    }
    const abort = new AbortController()
    detectAgentSessionContinuationAgents(worktreeId, abort.signal).then(
      (choices) => {
        if (abort.signal.aborted) {
          return
        }
        const state = useAppStore.getState()
        const hostId = getResolvedExecutionHostIdForWorktree(state, worktreeId)
        const chats = hostId ? chatProviderAgents(hostId, state.runtimeStatusByEnvironmentId) : []
        setFound({
          worktreeId,
          cli: choices.detected ?? [],
          chat: choices.offered.filter((agent) => chats.includes(agent))
        })
      },
      (error: unknown) => {
        if (!abort.signal.aborted) {
          console.warn('Agent detection for a chat fork failed', error)
          setFound({ worktreeId, cli: [], chat: [] })
        }
      }
    )
    return () => abort.abort()
  }, [worktreeId])
  const current = found && found.worktreeId === worktreeId ? found : null
  const others = getAgentCatalog()
    .map((agent) => agent.id)
    .filter(
      (agent) =>
        agent !== sourceAgent &&
        isTuiAgentEnabled(agent, disabled) &&
        (current?.cli.includes(agent) || current?.chat.includes(agent))
    )
  return {
    agents: [sourceAgent, ...others],
    chatAgents: current?.chat ?? null,
    cliAgents: current?.cli ?? null,
    detecting: worktreeId !== null && current === null
  }
}
