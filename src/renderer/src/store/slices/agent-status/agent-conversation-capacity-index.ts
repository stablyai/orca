import type { AppState } from '../../types'
import { readRecordChanges } from '../../keyed-record-change-reads'
import { isIndexKey } from '../../keyed-record-index-keys'
import {
  classifyPaneKeyLiveness,
  MAX_LIVE_AGENT_STATUSES,
  paneKeyCandidateTabIds
} from './agent-status-capacity-eviction'

type Conversations = AppState['agentConversationsByPaneKey']
type Layouts = AppState['terminalLayoutsByTabId']

/** Derived membership only; conversation values remain solely in the source record. */
export function createAgentConversationCapacityIndex() {
  let source: Conversations | null = null
  let layouts: Layouts | null = null
  let nextRank = 0
  const ranks = new Map<string, number>()
  const keysByTab = new Map<string, Set<string>>()
  const eligible = new Set<string>()
  const additions = new Set<string>()
  const compare = (a: string, b: string): number => {
    if (additions.has(a) !== additions.has(b)) {
      return additions.has(a) ? 1 : -1
    }
    const ai = isIndexKey(a)
    const bi = isIndexKey(b)
    return ai || bi
      ? ai && bi
        ? Number(a) - Number(b)
        : ai
          ? -1
          : 1
      : ranks.get(a)! - ranks.get(b)!
  }
  function remove(key: string): void {
    ranks.delete(key)
    eligible.delete(key)
    for (const tabId of paneKeyCandidateTabIds(key)) {
      const bucket = keysByTab.get(tabId)
      bucket?.delete(key)
      if (bucket?.size === 0) {
        keysByTab.delete(tabId)
      }
    }
  }
  function add(key: string): void {
    ranks.set(key, nextRank++)
    additions.add(key)
    for (const tabId of paneKeyCandidateTabIds(key)) {
      let bucket = keysByTab.get(tabId)
      if (!bucket) {
        keysByTab.set(tabId, (bucket = new Set()))
      }
      bucket.add(key)
    }
  }
  function cap(entries: Conversations, nextLayouts: Layouts): Conversations {
    const membership = source ? readRecordChanges(entries, source) : null
    const unknown = source === null || membership?.kind === 'full-resync'
    const affected = new Set<string>()
    if (unknown) {
      for (const key of ranks.keys()) {
        if (!Object.hasOwn(entries, key)) {
          remove(key)
        }
      }
      for (const key of Object.keys(entries)) {
        if (!ranks.has(key)) {
          add(key)
          affected.add(key)
        }
      }
    } else if (membership?.kind === 'addressed') {
      for (const key of membership.deleted) {
        remove(key)
      }
      for (const key of membership.added) {
        add(key)
        affected.add(key)
      }
    }
    const placement = layouts ? readRecordChanges(nextLayouts, layouts) : null
    if (layouts !== nextLayouts) {
      const tabs = placement?.kind === 'addressed' ? placement.keys : keysByTab.keys()
      for (const tabId of tabs) {
        const keys = keysByTab.get(tabId)
        if (!keys || layouts?.[tabId]?.root === nextLayouts[tabId]?.root) {
          continue
        }
        for (const key of keys) {
          affected.add(key)
        }
      }
    }
    if (affected.size > 0) {
      const classify = classifyPaneKeyLiveness(nextLayouts)
      for (const key of affected) {
        if (classify(key) === 'live') {
          eligible.delete(key)
        } else {
          eligible.add(key)
        }
      }
    }
    const evicted =
      eligible.size > MAX_LIVE_AGENT_STATUSES
        ? [...eligible].sort(compare).slice(0, eligible.size - MAX_LIVE_AGENT_STATUSES)
        : []
    for (const key of evicted) {
      remove(key)
    }
    let result = entries
    // Unknown writers may reorder survivors; preserve the established eviction order on output too.
    if (unknown || evicted.length > 0) {
      const oldIndices: string[] = []
      const survivors: string[] = []
      const appended: string[] = []
      for (const key of ranks.keys()) {
        if (additions.has(key)) {
          appended.push(key)
        } else if (isIndexKey(key)) {
          oldIndices.push(key)
        } else {
          survivors.push(key)
        }
      }
      const ordered = [
        ...oldIndices.sort((a, b) => Number(a) - Number(b)),
        ...survivors,
        ...appended
      ]
      const incoming = Object.keys(entries)
      if (ordered.length !== incoming.length || ordered.some((key, i) => key !== incoming[i])) {
        result = Object.fromEntries(ordered.map((key) => [key, entries[key]]))
      }
    }
    additions.clear()
    source = result
    layouts = nextLayouts
    return result
  }
  return {
    cap,
    matches: (state: AppState) =>
      source === state.agentConversationsByPaneKey && layouts === state.terminalLayoutsByTabId
  }
}
