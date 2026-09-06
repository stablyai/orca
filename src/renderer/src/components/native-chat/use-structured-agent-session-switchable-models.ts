import { useEffect, useMemo, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import {
  STRUCTURED_SWITCHABLE_AGENTS,
  type StructuredSwitchableAgent,
  withSwitchableStructuredModels
} from '../../../../shared/structured-agent-session-switchable-models'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

export function useStructuredAgentSessionSwitchableModels(input: {
  agent: AgentType
  target: RuntimeClientTarget
  worktreeId: string | undefined
  isVisible: boolean
  snapshot: SessionOptionDescriptor[]
  live: AgentSessionOptionsResult | null
}): SessionOptionDescriptor[] {
  const [supportedByAgent, setSupportedByAgent] = useState<
    Partial<Record<StructuredSwitchableAgent, boolean>>
  >({})
  useEffect(() => {
    if (!input.isVisible || !input.worktreeId) {
      return
    }
    let stale = false
    setSupportedByAgent({})
    const worktree = `id:${input.worktreeId}`
    void Promise.all(
      STRUCTURED_SWITCHABLE_AGENTS.map(async (agent) => {
        try {
          const support = await callStructuredAgentSession<{
            supported: boolean
            canSwitchProvider?: boolean
          }>(input.target, 'agentSession.createSupport', { worktree, agent })
          return [agent, support.supported && support.canSwitchProvider === true] as const
        } catch {
          return [agent, false] as const
        }
      })
    ).then((entries) => {
      if (!stale) {
        setSupportedByAgent(Object.fromEntries(entries))
      }
    })
    return () => {
      stale = true
    }
  }, [input.agent, input.isVisible, input.target, input.worktreeId])
  return useMemo(
    () =>
      withSwitchableStructuredModels(input.snapshot, {
        currentAgent: input.agent,
        live: input.live,
        supportedByAgent
      }),
    [input.agent, input.live, input.snapshot, supportedByAgent]
  )
}
