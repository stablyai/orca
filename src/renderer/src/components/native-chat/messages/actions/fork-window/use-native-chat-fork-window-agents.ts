import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { detectAgentSessionContinuationAgents } from '@/lib/agent-session/launch/continuation/launch-agent-session-continuation'
import { isTuiAgentEnabled } from '../../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'

export type NativeChatForkAgents = {
  /** The chat's own agent first, then the enabled agents the workspace's host can start. */
  agents: TuiAgent[]
  detecting: boolean
}

/** Agents a fork into `worktreeId` can start; only the chat's own agent until detection answers. */
export function useNativeChatForkAgents(
  worktreeId: string | null,
  sourceAgent: TuiAgent
): NativeChatForkAgents {
  const disabled = useAppStore((state) => state.settings?.disabledTuiAgents)
  const [found, setFound] = useState<{ worktreeId: string; agents: readonly TuiAgent[] } | null>(
    null
  )
  useEffect(() => {
    if (!worktreeId) {
      return
    }
    const abort = new AbortController()
    detectAgentSessionContinuationAgents(worktreeId, abort.signal).then(
      (choices) => {
        if (!abort.signal.aborted) {
          setFound({ worktreeId, agents: [...(choices.detected ?? []), ...choices.offered] })
        }
      },
      (error: unknown) => {
        if (!abort.signal.aborted) {
          console.warn('Agent detection for a chat fork failed', error)
          setFound({ worktreeId, agents: [] })
        }
      }
    )
    return () => abort.abort()
  }, [worktreeId])
  const current = found && found.worktreeId === worktreeId ? found.agents : null
  const others = getAgentCatalog()
    .map((agent) => agent.id)
    .filter(
      (agent) =>
        agent !== sourceAgent && isTuiAgentEnabled(agent, disabled) && current?.includes(agent)
    )
  return { agents: [sourceAgent, ...others], detecting: worktreeId !== null && current === null }
}
