import { useEffect, useState } from 'react'
import { isRecord } from '../../../../shared/agent-status-child-work-value-guards'
import type { AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { AiVaultSession, AiVaultSubagentListResult } from '../../../../shared/ai-vault-types'
import { isNativeChatSupportedAgent } from '../../../../shared/native-chat-agent-support'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

export type AgentSubagentSessionsState = {
  loading: boolean
  sessions: AiVaultSession[]
}

const EMPTY_STATE: AgentSubagentSessionsState = { loading: false, sessions: [] }

export function useAgentSubagentSessions({
  target,
  agent,
  parentFilePath,
  parentSessionId,
  structuredSessionId,
  liveSubagents = [],
  poll = false
}: {
  target: RuntimeClientTarget
  agent: string
  parentFilePath: string | null
  parentSessionId?: string | null
  structuredSessionId?: string
  liveSubagents?: readonly AgentSubagentSnapshot[]
  poll?: boolean
}): AgentSubagentSessionsState {
  const liveKey = liveSubagents.map((subagent) => `${subagent.id}:${subagent.state}`).join('|')
  const targetKey = target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
  const scopeKey = JSON.stringify([
    targetKey,
    agent,
    parentFilePath,
    parentSessionId,
    structuredSessionId
  ])
  const [loaded, setState] = useState<AgentSubagentSessionsState & { scopeKey: string }>({
    ...EMPTY_STATE,
    scopeKey
  })
  const state = loaded.scopeKey === scopeKey ? loaded : EMPTY_STATE
  const shouldPoll =
    poll ||
    liveSubagents.length > 0 ||
    state.sessions.some((session) => session.subagent?.status === 'running')

  useEffect(() => {
    if (
      (!parentFilePath && !parentSessionId && !structuredSessionId) ||
      !isNativeChatSupportedAgent(agent)
    ) {
      return
    }
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setInterval> | null = null
    const load = async (): Promise<void> => {
      if (cancelled || inFlight) {
        return
      }
      inFlight = true
      setState((current) =>
        current.scopeKey === scopeKey
          ? { ...current, loading: current.sessions.length === 0 }
          : { scopeKey, loading: true, sessions: [] }
      )
      try {
        let result = await callRuntimeRpc<unknown>(
          target,
          structuredSessionId ? 'agentSession.subagents' : 'aiVault.listSubagentSessions',
          structuredSessionId
            ? { sessionId: structuredSessionId, ...(parentFilePath ? { parentFilePath } : {}) }
            : parentFilePath
              ? { agent, parentFilePath }
              : { agent, parentSessionId },
          { timeoutMs: 15_000 }
        )
        // Older hosts ignore the optional nested-parent selector; never display their root list here.
        if (
          structuredSessionId &&
          parentFilePath &&
          (!isRecord(result) || result.parentFilePath !== parentFilePath)
        ) {
          result = await callRuntimeRpc<unknown>(
            target,
            'aiVault.listSubagentSessions',
            { agent, parentFilePath },
            { timeoutMs: 15_000 }
          )
        }
        if (!cancelled) {
          setState({ scopeKey, loading: false, sessions: parseSubagentList(result).sessions })
        }
      } catch {
        if (!cancelled) {
          setState((current) => ({ ...current, loading: false }))
        }
      } finally {
        inFlight = false
      }
    }
    void load()
    if (shouldPoll) {
      timer = setInterval(() => void load(), 2_000)
    }
    return () => {
      cancelled = true
      if (timer) {
        clearInterval(timer)
      }
    }
  }, [
    agent,
    liveKey,
    parentFilePath,
    parentSessionId,
    structuredSessionId,
    shouldPoll,
    target,
    targetKey,
    scopeKey
  ])

  return state
}

function parseSubagentList(value: unknown): AiVaultSubagentListResult {
  const sessions =
    isRecord(value) && Array.isArray(value.sessions) ? value.sessions.filter(isSession) : []
  return { sessions, issues: [] }
}

function isSession(value: unknown): value is AiVaultSession {
  if (!isRecord(value)) {
    return false
  }
  const session = value
  return (
    typeof session.id === 'string' &&
    typeof session.sessionId === 'string' &&
    typeof session.title === 'string' &&
    typeof session.filePath === 'string' &&
    typeof session.agent === 'string' &&
    (session.subagent === null || typeof session.subagent === 'object')
  )
}
