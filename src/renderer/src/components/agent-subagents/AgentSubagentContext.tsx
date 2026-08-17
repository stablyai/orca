import { createContext, useContext } from 'react'
import { Bot } from 'lucide-react'
import type { AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentType } from '../../../../shared/native-chat-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { AgentDotState } from '@/components/AgentStateDot'

export type AgentSubagentSource = {
  key: string
  identity: string
  showIdentity?: boolean
  agent: AgentType
  paneKey?: string
  sessionId: string | null
  structuredSessionId?: string
  transcriptPath: string | null
  runtimeEnvironmentId?: string | null
  target: RuntimeClientTarget
  liveSubagents: readonly AgentSubagentSnapshot[]
  working?: boolean
}

export type AgentSubagentSourceData = {
  source: AgentSubagentSource
  loading: boolean
  sessions: AiVaultSession[]
}

export type SubagentSelection = {
  sourceData: AgentSubagentSourceData
  session: AiVaultSession
}

export function subagentStatusDot(session: AiVaultSession): AgentDotState {
  if (session.subagent?.status === 'failed') {
    return 'failed'
  }
  if (session.subagent?.status === 'stopped') {
    return 'interrupted'
  }
  return 'done'
}

type AgentSubagentContextValue = {
  dataBySource: Readonly<Record<string, AgentSubagentSourceData>>
  open: (sourceKey?: string, sessionId?: string) => void
}

export const AgentSubagentContext = createContext<AgentSubagentContextValue | null>(null)

export function AgentSubagentTurnLink({
  sourceKey,
  startedAt,
  completedAt
}: {
  sourceKey: string
  startedAt: number | null
  completedAt: number | null
}): React.JSX.Element | null {
  const context = useContext(AgentSubagentContext)
  const data = context?.dataBySource[sourceKey]
  if (!context || !data || startedAt == null) {
    return null
  }
  const rows = subagentsInTurn(data, startedAt, completedAt)
  if (rows.length === 0) {
    return null
  }
  const names = rows
    .slice(0, 2)
    .map((row) => row.description)
    .filter(Boolean)
    .join(', ')
  return (
    <button
      type="button"
      onClick={() => context.open(sourceKey, rows.length === 1 ? rows[0]!.id : undefined)}
      className="mt-1.5 flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/20 px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Bot className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">
        {translate('agentSubagents.turn.count', '{{count}} subagents', { count: rows.length })}
      </span>
      {names ? <span className="truncate">· {names}</span> : null}
      {rows.some((row) => row.active) ? (
        <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      ) : null}
    </button>
  )
}

export function subagentsInTurn(
  data: AgentSubagentSourceData,
  startedAt: number,
  completedAt: number | null
): { id: string; description: string; active: boolean }[] {
  const from = startedAt - 2_000
  const to = completedAt == null ? Number.POSITIVE_INFINITY : completedAt + 2_000
  const rows = new Map<string, { id: string; description: string; active: boolean }>()
  for (const live of data.source.liveSubagents) {
    if (live.startedAt >= from && live.startedAt <= to) {
      rows.set(live.id, {
        id: live.id,
        description: subagentDisplayName(live.description, live.agentType),
        active: live.state === 'working' || live.state === 'blocked' || live.state === 'waiting'
      })
    }
  }
  for (const session of data.sessions) {
    const timestamps = session.subagent?.turnStartedAts ?? [
      Date.parse(session.createdAt ?? session.modifiedAt)
    ]
    if (
      !timestamps.some(
        (timestamp) => Number.isFinite(timestamp) && timestamp >= from && timestamp <= to
      )
    ) {
      continue
    }
    const existing = rows.get(session.sessionId)
    rows.set(session.sessionId, {
      id: session.sessionId,
      description: subagentDisplayName(session.title, existing?.description),
      active: existing?.active ?? session.subagent?.status === 'running'
    })
  }
  return [...rows.values()]
}

export function useAgentSubagentContext(): AgentSubagentContextValue | null {
  return useContext(AgentSubagentContext)
}

export function subagentDisplayName(
  description: string | null | undefined,
  fallback: string | null | undefined
): string {
  return description && !description.startsWith('/root/') ? description : (fallback ?? 'Subagent')
}
