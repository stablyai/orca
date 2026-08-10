import { useEffect, useState } from 'react'
import type { AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { AiVaultSession, AiVaultSubagentListResult } from '../../../../shared/ai-vault-types'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

export type AgentSubagentSessionsState = {
  loading: boolean
  sessions: AiVaultSession[]
}

export function useAgentSubagentSessions({
  target,
  agent,
  parentFilePath,
  liveSubagents = [],
  poll = false
}: {
  target: RuntimeClientTarget
  agent: string
  parentFilePath: string | null
  liveSubagents?: readonly AgentSubagentSnapshot[]
  poll?: boolean
}): AgentSubagentSessionsState {
  const [state, setState] = useState<AgentSubagentSessionsState>({ loading: false, sessions: [] })
  const liveKey = liveSubagents.map((subagent) => `${subagent.id}:${subagent.state}`).join('|')
  const targetKey = target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'

  useEffect(() => {
    if (!parentFilePath || !supportsSubagentTranscripts(agent)) {
      setState({ loading: false, sessions: [] })
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    const load = async (): Promise<void> => {
      setState((current) => ({ ...current, loading: current.sessions.length === 0 }))
      try {
        const result = await callRuntimeRpc<unknown>(
          target,
          'aiVault.listSubagentSessions',
          { agent, parentFilePath },
          { timeoutMs: 15_000 }
        )
        if (!cancelled) {
          setState({ loading: false, sessions: parseSubagentList(result).sessions })
        }
      } catch {
        if (!cancelled) {
          setState((current) => ({ ...current, loading: false }))
        }
      }
    }
    void load()
    if (poll || liveSubagents.length > 0) {
      timer = setInterval(() => void load(), 2_000)
    }
    return () => {
      cancelled = true
      if (timer) {
        clearInterval(timer)
      }
    }
  }, [agent, liveKey, liveSubagents.length, parentFilePath, poll, target, targetKey])

  return state
}

function supportsSubagentTranscripts(agent: string): boolean {
  return agent === 'claude' || agent === 'openclaude' || agent === 'codex'
}

function parseSubagentList(value: unknown): AiVaultSubagentListResult {
  const sessions =
    value && typeof value === 'object' && Array.isArray((value as { sessions?: unknown }).sessions)
      ? (value as { sessions: unknown[] }).sessions.filter(isSession)
      : []
  return { sessions, issues: [] }
}

function isSession(value: unknown): value is AiVaultSession {
  if (!value || typeof value !== 'object') {
    return false
  }
  const session = value as Partial<AiVaultSession>
  return (
    typeof session.id === 'string' &&
    typeof session.sessionId === 'string' &&
    typeof session.title === 'string' &&
    typeof session.filePath === 'string' &&
    typeof session.agent === 'string' &&
    (session.subagent === null || typeof session.subagent === 'object')
  )
}
