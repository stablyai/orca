import {
  AGENT_CHILD_WORK_ALIAS_KINDS,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasKind
} from './agent-status-child-work-alias'
import {
  agentChildWorkFencesEqual,
  type AgentChildWorkId,
  type AgentChildWorkInput,
  type AgentChildWorkInvocationFence,
  type AgentChildWorkKind,
  type AgentChildWorkMembership,
  type AgentChildWorkOperation,
  type AgentChildWorkOutcome,
  type AgentChildWorkState
} from './agent-status-child-work'
import { agentStatusSubjectsEqual } from './agent-status-subject'
import { groupedBy } from './grouped-by'

/** Publish read-only child views without host bookkeeping. Decode foreign versions permissively or gate by capability, never with the strict record codec. */
export type AgentChildWorkView = {
  id: AgentChildWorkId
  /** Provider ID for tasks/subagents; absent without a current-invocation handle, so legacy projections omit the row. */
  providerId?: string
  kind: AgentChildWorkKind
  name?: string
  description?: string
  agentType?: string
  model?: string
  state: AgentChildWorkState
  membership: AgentChildWorkMembership
  outcome?: AgentChildWorkOutcome
  operation?: AgentChildWorkOperation
  lastMessage?: string
  /** Present only when the owner is in the same projection; otherwise the main agent owns it. */
  parentChildWorkId?: AgentChildWorkId
  firstObservedAt: number
  observedAt: number
  settledAt?: number
  totalTokens?: number
  stoppable: boolean
  invocation: AgentChildWorkInvocationFence
}

export type AgentChildWorkViewAlias = Pick<
  AgentChildWorkAliasInput,
  'childWorkId' | 'aliasKind' | 'alias' | 'fence'
>

// Rank stable handles before per-call IDs changed by resume; require a rank for every alias kind to preserve providerId.
const PROVIDER_ID_ALIAS_RANK: Record<AgentChildWorkAliasKind, number> = {
  task_id: 0,
  thread_id: 1,
  tool_use_id: 2,
  turn_id: 3
}
const PROVIDER_ID_ALIAS_ORDER = [...AGENT_CHILD_WORK_ALIAS_KINDS].sort(
  (left, right) => PROVIDER_ID_ALIAS_RANK[left] - PROVIDER_ID_ALIAS_RANK[right]
)

function providerIdFor(
  record: AgentChildWorkInput,
  aliases: readonly AgentChildWorkViewAlias[]
): string | undefined {
  const current = aliases.filter((alias) =>
    agentChildWorkFencesEqual(alias.fence, record.invocation)
  )
  for (const kind of PROVIDER_ID_ALIAS_ORDER) {
    const match = current.find((alias) => alias.aliasKind === kind)
    if (match) {
      return match.alias
    }
  }
  return undefined
}

function isOnOwnershipCycle(
  start: AgentChildWorkInput,
  byId: ReadonlyMap<AgentChildWorkId, AgentChildWorkInput>
): boolean {
  const seen = new Set<AgentChildWorkId>()
  let cursor = start.parentChildWorkId
  while (cursor !== undefined && !seen.has(cursor)) {
    if (cursor === start.childWorkId) {
      return true
    }
    seen.add(cursor)
    cursor = byId.get(cursor)?.parentChildWorkId
  }
  return false
}

/** An owner that is gone, belongs to another session, or closes a cycle does not own the work. */
function resolvedOwner(
  record: AgentChildWorkInput,
  byId: ReadonlyMap<AgentChildWorkId, AgentChildWorkInput>
): AgentChildWorkId | undefined {
  const owner =
    record.parentChildWorkId === undefined ? undefined : byId.get(record.parentChildWorkId)
  return owner &&
    agentStatusSubjectsEqual(owner.parent, record.parent) &&
    !isOnOwnershipCycle(record, byId)
    ? owner.childWorkId
    : undefined
}

/** Every surface starts here; foreground Codex tools stay in status records and tool rows. */
export function projectAgentChildWorkViews(
  records: readonly AgentChildWorkInput[],
  aliases: readonly AgentChildWorkViewAlias[]
): AgentChildWorkView[] {
  const visible = records.filter(
    (record) =>
      record.provider !== 'codex' || record.kind !== 'command' || record.residency !== 'foreground'
  )
  const byId = new Map(visible.map((record) => [record.childWorkId, record]))
  const aliasesByChild = groupedBy(aliases, (alias) => alias.childWorkId)
  return visible.map((record) => {
    const providerId = providerIdFor(record, aliasesByChild.get(record.childWorkId) ?? [])
    const owner = resolvedOwner(record, byId)
    return {
      id: record.childWorkId,
      ...(providerId !== undefined ? { providerId } : {}),
      kind: record.kind,
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.description !== undefined ? { description: record.description } : {}),
      ...(record.agentType !== undefined ? { agentType: record.agentType } : {}),
      ...(record.model !== undefined ? { model: record.model } : {}),
      state: record.state,
      membership: record.membership,
      ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
      ...(record.operation !== undefined ? { operation: { ...record.operation } } : {}),
      ...(record.lastMessage !== undefined ? { lastMessage: record.lastMessage } : {}),
      ...(owner !== undefined ? { parentChildWorkId: owner } : {}),
      firstObservedAt: record.firstObservedAt,
      observedAt: record.observedAt,
      ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
      ...(record.totalTokens !== undefined ? { totalTokens: record.totalTokens } : {}),
      stoppable: record.stoppable,
      invocation: { ...record.invocation }
    }
  })
}
