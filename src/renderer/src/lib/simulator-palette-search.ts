import type { Tab, TabGroup, Worktree } from '../../../shared/types'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import type { MatchRange } from './worktree-palette-search'

export type SearchableSimulatorTab = {
  tab: Tab
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  isCurrentTab: boolean
  isCurrentWorktree: boolean
}

export type SimulatorPaletteSearchResult = {
  tabId: string
  worktreeId: string
  groupId: string
  title: string
  secondaryText: string
  repoName: string
  worktreeName: string
  titleRange: MatchRange | null
  secondaryRange: MatchRange | null
  repoRange: MatchRange | null
  worktreeRange: MatchRange | null
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  score: number
}

type SimulatorPaletteActiveTabType = 'browser' | 'editor' | 'terminal' | 'simulator' | 'tasks'

export const SIMULATOR_PALETTE_QUERY_MAX_BYTES = 2 * 1024

export function isSimulatorPaletteQueryTooLarge(
  query: string,
  maxBytes = SIMULATOR_PALETTE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export type BuildSearchableSimulatorTabsOptions = {
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  activeTabType: SimulatorPaletteActiveTabType
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function findRange(text: string, query: string): MatchRange | null {
  if (!query) {
    return null
  }
  const start = text.toLowerCase().indexOf(query)
  if (start === -1) {
    return null
  }
  return { start, end: start + query.length }
}

function compareEmptyQueryResults(
  a: SimulatorPaletteSearchResult,
  b: SimulatorPaletteSearchResult
): number {
  if (a.isCurrentTab !== b.isCurrentTab) {
    return a.isCurrentTab ? -1 : 1
  }
  if (a.isCurrentWorktree !== b.isCurrentWorktree) {
    return a.isCurrentWorktree ? -1 : 1
  }
  if (a.score !== b.score) {
    return a.score - b.score
  }
  const worktreeCmp = compareText(a.worktreeName, b.worktreeName)
  if (worktreeCmp !== 0) {
    return worktreeCmp
  }
  return compareText(a.title, b.title)
}

function scoreSimulatorTabMatch({
  fieldWeight,
  matchIndex,
  entry
}: {
  fieldWeight: number
  matchIndex: number
  entry: SearchableSimulatorTab
}): number {
  let score = fieldWeight + matchIndex + entry.worktreeSortIndex * 100
  if (entry.isCurrentTab) {
    score -= 40
  } else if (entry.isCurrentWorktree) {
    score -= 10
  }
  return score
}

function getActiveUnifiedTabId({
  worktreeId,
  activeWorktreeId,
  activeTabType,
  activeGroupIdByWorktree,
  groupsByWorktree
}: Pick<
  BuildSearchableSimulatorTabsOptions,
  'activeGroupIdByWorktree' | 'activeTabType' | 'activeWorktreeId' | 'groupsByWorktree'
> & {
  worktreeId: string
}): string | null {
  if (activeWorktreeId !== worktreeId || activeTabType !== 'simulator') {
    return null
  }
  const activeGroupId = activeGroupIdByWorktree[worktreeId]
  const activeGroup = activeGroupId
    ? (groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
    : undefined
  return activeGroup?.activeTabId ?? null
}

export function buildSearchableSimulatorTabs({
  worktrees,
  repoMap,
  worktreeOrder,
  unifiedTabsByWorktree,
  activeGroupIdByWorktree,
  groupsByWorktree,
  activeWorktreeId,
  activeTabType
}: BuildSearchableSimulatorTabsOptions): SearchableSimulatorTab[] {
  const entries: SearchableSimulatorTab[] = []
  for (const worktree of worktrees) {
    const repoName = repoMap.get(worktree.repoId)?.displayName ?? ''
    const worktreeSortIndex = worktreeOrder.get(worktree.id) ?? Number.MAX_SAFE_INTEGER
    const activeUnifiedTabId = getActiveUnifiedTabId({
      worktreeId: worktree.id,
      activeWorktreeId,
      activeTabType,
      activeGroupIdByWorktree,
      groupsByWorktree
    })
    const tabs = unifiedTabsByWorktree[worktree.id] ?? []
    for (const tab of tabs) {
      if (tab.contentType !== 'simulator') {
        continue
      }
      entries.push({
        tab,
        worktree,
        repoName,
        worktreeSortIndex,
        // Why: simulator tabs are unified tabs; terminal activeTabId does not
        // identify the visible emulator tab after split-group activation.
        isCurrentTab: activeUnifiedTabId === tab.id,
        isCurrentWorktree: activeWorktreeId === worktree.id
      })
    }
  }
  return entries
}

export function searchSimulatorTabs(
  entries: SearchableSimulatorTab[],
  query: string
): SimulatorPaletteSearchResult[] {
  if (isSimulatorPaletteQueryTooLarge(query)) {
    return []
  }
  const trimmed = query.trim()
  const trimmedQuery = trimmed.toLowerCase()
  const results: SimulatorPaletteSearchResult[] = []

  for (const entry of entries) {
    const title = entry.tab.label || 'Mobile Emulator'
    const secondaryText = 'Mobile Emulator tab'
    const baseResult = {
      tabId: entry.tab.id,
      worktreeId: entry.worktree.id,
      groupId: entry.tab.groupId,
      title,
      secondaryText,
      repoName: entry.repoName,
      worktreeName: entry.worktree.displayName,
      isCurrentTab: entry.isCurrentTab,
      isCurrentWorktree: entry.isCurrentWorktree
    }

    if (!trimmedQuery) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        // Why: simulator tabs follow browser-tab Cmd+J ordering: deterministic
        // and context-first until Orca tracks per-tab recency for this surface.
        score: entry.isCurrentTab
          ? -2
          : entry.isCurrentWorktree
            ? -1
            : entry.worktreeSortIndex * 100
      })
      continue
    }

    const titleRange = findRange(title, trimmedQuery)
    if (titleRange) {
      results.push({
        ...baseResult,
        titleRange,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        score: scoreSimulatorTabMatch({ fieldWeight: 0, matchIndex: titleRange.start, entry })
      })
      continue
    }

    const secondaryRange = findRange(secondaryText, trimmedQuery)
    if (secondaryRange) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange,
        repoRange: null,
        worktreeRange: null,
        score: scoreSimulatorTabMatch({
          fieldWeight: 20,
          matchIndex: secondaryRange.start,
          entry
        })
      })
      continue
    }

    const aliasRange = findRange('ios simulator', trimmedQuery)
    if (aliasRange) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        score: scoreSimulatorTabMatch({ fieldWeight: 24, matchIndex: aliasRange.start, entry })
      })
      continue
    }

    const worktreeRange = findRange(entry.worktree.displayName, trimmedQuery)
    if (worktreeRange) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange,
        score: scoreSimulatorTabMatch({
          fieldWeight: 40,
          matchIndex: worktreeRange.start,
          entry
        })
      })
      continue
    }

    const repoRange = findRange(entry.repoName, trimmedQuery)
    if (repoRange) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange: null,
        repoRange,
        worktreeRange: null,
        score: scoreSimulatorTabMatch({ fieldWeight: 60, matchIndex: repoRange.start, entry })
      })
    }
  }

  return results.sort((a, b) => {
    if (!trimmedQuery) {
      return compareEmptyQueryResults(a, b)
    }
    if (a.score !== b.score) {
      return a.score - b.score
    }
    return compareEmptyQueryResults(a, b)
  })
}
