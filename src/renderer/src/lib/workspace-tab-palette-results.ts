import type { MatchRange } from './worktree-palette-search'
import type {
  SearchableWorkspaceTab,
  WorkspaceTabContentType
} from './workspace-tab-palette-search'

export type WorkspaceTabPaletteSearchResult = {
  tabId: string
  entityId: string
  worktreeId: string
  groupId: string
  contentType: WorkspaceTabContentType
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
  a: WorkspaceTabPaletteSearchResult,
  b: WorkspaceTabPaletteSearchResult
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

function scoreWorkspaceTabMatch({
  fieldWeight,
  matchIndex,
  entry
}: {
  fieldWeight: number
  matchIndex: number
  entry: SearchableWorkspaceTab
}): number {
  // Why: lower scores rank first; field weights preserve title > path > agent
  // snippet > worktree > repo ordering while tab position breaks ties.
  let score =
    fieldWeight +
    matchIndex +
    entry.worktreeSortIndex * 100 +
    entry.groupSortIndex * 10 +
    entry.tabSortIndex
  if (entry.isCurrentTab) {
    score -= 40
  } else if (entry.isCurrentWorktree) {
    score -= 10
  }
  return score
}

function getBestAgentSnippet(
  entry: SearchableWorkspaceTab,
  query: string
): { text: string; range: MatchRange } | null {
  for (const metadata of entry.agentMetadata) {
    for (const snippet of metadata.snippetCandidates) {
      const range = findRange(snippet, query)
      if (range) {
        return { text: snippet, range }
      }
    }
  }
  for (const metadata of entry.agentMetadata) {
    for (const text of metadata.textParts) {
      const range = findRange(text, query)
      if (range) {
        return { text, range }
      }
    }
  }
  return null
}

export function searchWorkspaceTabs(
  entries: SearchableWorkspaceTab[],
  query: string
): WorkspaceTabPaletteSearchResult[] {
  const trimmedQuery = query.trim().toLowerCase()
  const results: WorkspaceTabPaletteSearchResult[] = []

  for (const entry of entries) {
    const baseResult = {
      tabId: entry.tab.id,
      entityId: entry.tab.entityId,
      worktreeId: entry.worktree.id,
      groupId: entry.tab.groupId,
      contentType: entry.tab.contentType,
      title: entry.title,
      secondaryText: entry.secondaryText,
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
        score: entry.isCurrentTab
          ? -2
          : entry.isCurrentWorktree
            ? -1
            : entry.worktreeSortIndex * 100 + entry.groupSortIndex * 10 + entry.tabSortIndex
      })
      continue
    }

    const titleRange = findRange(entry.titleSearchText, trimmedQuery)
    if (titleRange) {
      results.push({
        ...baseResult,
        titleRange,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        score: scoreWorkspaceTabMatch({ fieldWeight: 0, matchIndex: titleRange.start, entry })
      })
      continue
    }

    let secondaryMatch: { text: string; range: MatchRange } | null = null
    for (const secondaryText of entry.secondarySearchTexts) {
      const range = findRange(secondaryText, trimmedQuery)
      if (range) {
        secondaryMatch = { text: secondaryText, range }
        break
      }
    }
    if (secondaryMatch) {
      results.push({
        ...baseResult,
        secondaryText: secondaryMatch.text,
        titleRange: null,
        secondaryRange: secondaryMatch.range,
        repoRange: null,
        worktreeRange: null,
        score: scoreWorkspaceTabMatch({
          fieldWeight: 20,
          matchIndex: secondaryMatch.range.start,
          entry
        })
      })
      continue
    }

    const agentMatch = getBestAgentSnippet(entry, trimmedQuery)
    if (agentMatch) {
      results.push({
        ...baseResult,
        secondaryText: agentMatch.text,
        titleRange: null,
        secondaryRange: agentMatch.range,
        repoRange: null,
        worktreeRange: null,
        score: scoreWorkspaceTabMatch({
          fieldWeight: 30,
          matchIndex: agentMatch.range.start,
          entry
        })
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
        score: scoreWorkspaceTabMatch({
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
        score: scoreWorkspaceTabMatch({ fieldWeight: 60, matchIndex: repoRange.start, entry })
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
