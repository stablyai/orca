import { createContext, useContext } from 'react'
import { Bot } from 'lucide-react'
import type { AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  isToolCallBlock,
  type AgentType,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import { isSubagentToolName } from '../../../../shared/native-chat-tool-name'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'

export type AgentSubagentSource = {
  key: string
  identity: string
  agent: AgentType
  paneKey: string
  sessionId: string | null
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

type AgentSubagentContextValue = {
  dataBySource: Readonly<Record<string, AgentSubagentSourceData>>
  open: (sourceKey?: string, sessionId?: string) => void
}

export const AgentSubagentContext = createContext<AgentSubagentContextValue | null>(null)

const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

export function AgentSubagentTurnLink({
  sourceKey,
  startedAt,
  completedAt,
  messages = EMPTY_MESSAGES
}: {
  sourceKey: string
  startedAt: number | null
  completedAt: number | null
  messages?: readonly NativeChatMessage[]
}): React.JSX.Element | null {
  const context = useContext(AgentSubagentContext)
  const data = context?.dataBySource[sourceKey]
  if (!context || !data || startedAt == null) {
    return null
  }
  const rows = subagentsInTurn(data, startedAt, completedAt)
  const coordinated = messages.some((message) =>
    message.blocks.some((block) => isToolCallBlock(block) && isSubagentToolName(block.name))
  )
  if (rows.length === 0 && !coordinated) {
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
        {rows.length > 0
          ? translate('agentSubagents.turn.count', '{{count}} subagents', { count: rows.length })
          : 'Subagents'}
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
