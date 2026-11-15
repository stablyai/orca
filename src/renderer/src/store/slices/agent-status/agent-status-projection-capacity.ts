import type { AppState } from '../../types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { KeyedDeadlines } from '../../../../../shared/keyed-deadlines'
import { classifyPaneKeyLiveness } from './agent-status-capacity-eviction'
import type { Candidate } from './agent-status-projection-types'
import type { AgentStatusProjectionState } from './agent-status-projection-state'

type CapacityDraft = {
  offset: number
  nextRank: number
  ranks: Map<string, number | null>
  candidates: Map<string, Candidate | null>
  dead: KeyedDeadlines
  fresh: KeyedDeadlines
  expiries: KeyedDeadlines
}
const drafts = new WeakMap<AppState['agentStatusByPaneKey'], CapacityDraft>()

export function projectionEvictionKeys(
  data: AgentStatusProjectionState,
  statuses: AppState['agentStatusByPaneKey'],
  layouts: AppState['terminalLayoutsByTabId'],
  protectedKey: string,
  now: number,
  max: number
): string[] {
  if (statuses.awakeSize <= max) {
    return []
  }
  let draft = drafts.get(statuses)
  if (!draft || draft.offset > statuses.replacementCount) {
    draft = {
      offset: 0,
      nextRank: data.nextRank,
      ranks: new Map(),
      candidates: new Map(),
      dead: data.deadCandidates.fork(),
      fresh: data.freshCandidates.fork(),
      expiries: data.candidateExpiries.fork()
    }
    drafts.set(statuses, draft)
  }
  const classify = classifyPaneKeyLiveness(layouts)
  for (const [key, row] of statuses.replacementsSince(draft.offset)) {
    draft.dead.delete(key)
    draft.fresh.delete(key)
    draft.expiries.delete(key)
    const rank = row
      ? draft.ranks.has(key)
        ? (draft.ranks.get(key) ?? draft.nextRank++)
        : (data.ranks.get(key) ?? draft.nextRank++)
      : null
    draft.ranks.set(key, rank)
    const liveness = row && !row.paneSleep ? classify(key) : 'live'
    const candidate =
      row && liveness !== 'live'
        ? { rank: rank!, updatedAt: row.updatedAt, dead: liveness === 'dead' }
        : null
    draft.candidates.set(key, candidate)
    if (candidate) {
      if (candidate.dead || now - candidate.updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
        draft.dead.set(key, candidate.rank)
      } else {
        draft.fresh.set(key, candidate.rank)
        draft.expiries.set(key, candidate.updatedAt + AGENT_STATUS_STALE_AFTER_MS)
      }
    }
  }
  draft.offset = statuses.replacementCount
  for (const key of draft.expiries.takeDue(now)) {
    const candidate = draft.candidates.has(key)
      ? draft.candidates.get(key)
      : data.candidates.get(key)
    if (candidate) {
      draft.fresh.delete(key)
      draft.dead.set(key, candidate.rank)
    }
  }
  const needed = statuses.awakeSize - max
  const select = (heap: KeyedDeadlines, count: number): string[] =>
    heap
      .firstKeys(count + 1)
      .filter((key) => key !== protectedKey)
      .slice(0, count)
  const candidates = select(draft.dead, needed)
  if (candidates.length < needed) {
    candidates.push(...select(draft.fresh, needed - candidates.length))
  }
  return candidates
}
