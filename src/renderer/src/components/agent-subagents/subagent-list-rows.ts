import { agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'
import type { AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  subagentDisplayName,
  subagentStatusDot,
  type AgentSubagentSourceData
} from './AgentSubagentContext'

export type SubagentRow = {
  id: string
  title: string
  subtitle: string | null
  state: AgentDotState
  session: AiVaultSession | null
  sourceData: AgentSubagentSourceData
}

export function splitSubagentRows(
  data: AgentSubagentSourceData,
  showIdentity: boolean
): { active: SubagentRow[]; done: SubagentRow[]; unknown: SubagentRow[] } {
  const sessionsById = new Map(data.sessions.map((session) => [session.sessionId, session]))
  const active = data.source.liveSubagents.map((subagent) =>
    liveRow(data, subagent, sessionsById.get(subagent.id) ?? null, showIdentity)
  )
  const activeIds = new Set(active.map((row) => row.id))
  for (const session of data.sessions) {
    if (session.subagent?.status === 'running' && !activeIds.has(session.sessionId)) {
      active.push(sessionRow(data, session, 'working', showIdentity))
      activeIds.add(session.sessionId)
    }
  }
  const done = data.sessions
    .filter((session) => !activeIds.has(session.sessionId) && session.subagent?.status != null)
    .map((session) => sessionRow(data, session, subagentStatusDot(session), showIdentity))
  const unknown = data.sessions
    .filter((session) => !activeIds.has(session.sessionId) && session.subagent?.status == null)
    .map((session) => sessionRow(data, session, 'unverifiable', showIdentity))
  return { active, done, unknown }
}

function liveRow(
  sourceData: AgentSubagentSourceData,
  subagent: AgentSubagentSnapshot,
  session: AiVaultSession | null,
  showIdentity: boolean
): SubagentRow {
  const state: AgentDotState =
    subagent.state === 'blocked'
      ? 'blocked'
      : subagent.state === 'idle'
        ? 'waiting'
        : subagent.state === 'waiting'
          ? 'waiting'
          : 'working'
  return {
    id: subagent.id,
    title: session
      ? subagentDisplayName(session.title, subagent.agentType)
      : subagentDisplayName(subagent.description, subagent.agentType),
    subtitle: `${showIdentity && sourceData.source.showIdentity !== false ? `@${sourceData.source.identity} · ` : ''}${agentStateLabel(state)}`,
    state,
    session,
    sourceData
  }
}

function sessionRow(
  sourceData: AgentSubagentSourceData,
  session: AiVaultSession,
  state: AgentDotState,
  showIdentity: boolean
): SubagentRow {
  return {
    id: session.sessionId,
    title: subagentDisplayName(session.title, session.subagent?.agentType),
    subtitle: `${showIdentity && sourceData.source.showIdentity !== false ? `@${sourceData.source.identity} · ` : ''}${translate(
      'agentSubagents.messageCount',
      '{{count}} messages',
      { count: session.messageCount }
    )}`,
    state,
    session,
    sourceData
  }
}
