import type { AgentType } from '../../agent-status/contracts/agent-status-types'

/** A place in a chat's matches: the occurrence-th match inside one message. */
export type NativeChatFindPosition = { entryId: string; occurrence: number }

export type NativeChatFindInput = {
  query: string
  /** Where stepping starts, such as the match on screen or a search result's message. */
  start?: NativeChatFindPosition
  /** Steps from `start` (or the first match), wrapping. */
  offset?: number
  /** An absolute match index; wins over start and offset. */
  index?: number
}

export type NativeChatFindNavigationEntry = {
  entryId: string
  count: number
  /** Index of this message's first match among all matches. */
  startIndex: number
}

export type NativeChatFindResult = {
  totalMatches: number
  activeIndex: number
  /** Messages with matches around the selected one, so nearby steps need no host call. */
  navigation: NativeChatFindNavigationEntry[]
  match: NativeChatFindPosition | null
}

/** A search of one chat's whole history on the host that owns it. */
export type NativeChatFindArgs = {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  input: NativeChatFindInput
}

/** `unsupported`: this chat's history is not searchable on its host; the bar searches what is drawn. */
export type NativeChatFindOutcome = NativeChatFindResult | { unsupported: true } | { error: string }

/** One searchable message and how many times it holds the query, in chat order. */
export type NativeChatFindDocument = { entryId: string; count: number }

const NAVIGATION_ENTRIES = 17

export function selectNativeChatFindMatch(
  documents: readonly NativeChatFindDocument[],
  input: Pick<NativeChatFindInput, 'start' | 'offset' | 'index'>
): NativeChatFindResult {
  let totalMatches = 0
  for (const document of documents) {
    totalMatches += document.count
  }
  let requestedIndex = input.index ?? 0
  if (input.index === undefined && input.start) {
    let before = 0
    for (const document of documents) {
      if (document.entryId === input.start.entryId) {
        requestedIndex = before + Math.min(input.start.occurrence, document.count)
        if (requestedIndex >= totalMatches) {
          requestedIndex = 0
        }
        break
      }
      before += document.count
    }
  }
  const activeIndex =
    input.index === undefined && totalMatches > 0
      ? (((requestedIndex + (input.offset ?? 0)) % totalMatches) + totalMatches) % totalMatches
      : Math.min(requestedIndex, Math.max(0, totalMatches - 1))

  const entries: NativeChatFindNavigationEntry[] = []
  let selectedEntry = -1
  let startIndex = 0
  for (const { entryId, count } of documents) {
    if (count > 0) {
      if (activeIndex >= startIndex && activeIndex < startIndex + count) {
        selectedEntry = entries.length
      }
      entries.push({ entryId, count, startIndex })
    }
    startIndex += count
  }
  const selected = entries[selectedEntry]
  const navigation =
    entries.length <= NAVIGATION_ENTRIES
      ? entries
      : Array.from(
          { length: NAVIGATION_ENTRIES },
          (_, i) =>
            entries[
              (selectedEntry + i - (NAVIGATION_ENTRIES >> 1) + entries.length) % entries.length
            ]!
        )
  return {
    totalMatches,
    activeIndex,
    navigation,
    match: selected
      ? { entryId: selected.entryId, occurrence: activeIndex - selected.startIndex }
      : null
  }
}

/** The match `delta` steps from `activeIndex`, when the result's navigation holds it. */
export function stepNativeChatFindLocally(
  result: NativeChatFindResult,
  activeIndex: number,
  delta: number
): { activeIndex: number; match: NativeChatFindPosition } | null {
  const total = result.totalMatches
  if (total <= 0) {
    return null
  }
  const next = (((activeIndex + delta) % total) + total) % total
  const entry = result.navigation.find(
    (candidate) => next >= candidate.startIndex && next < candidate.startIndex + candidate.count
  )
  return entry
    ? { activeIndex: next, match: { entryId: entry.entryId, occurrence: next - entry.startIndex } }
    : null
}
