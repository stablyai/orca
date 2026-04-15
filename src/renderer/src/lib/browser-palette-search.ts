import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'
import type { BrowserPage, BrowserWorkspace, Worktree } from '../../../shared/types'
import type { MatchRange } from './worktree-palette-search'

export type SearchableBrowserPage = {
  page: BrowserPage
  workspace: BrowserWorkspace
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  isCurrentPage: boolean
  isCurrentWorktree: boolean
}

export type BrowserPaletteSearchResult = {
  pageId: string
  workspaceId: string
  worktreeId: string
  title: string
  secondaryText: string
  workspaceLabel: string | null
  repoName: string
  worktreeName: string
  workspaceRange: MatchRange | null
  titleRange: MatchRange | null
  secondaryRange: MatchRange | null
  repoRange: MatchRange | null
  worktreeRange: MatchRange | null
  isCurrentPage: boolean
  isCurrentWorktree: boolean
  score: number
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

export function isBlankBrowserUrl(url: string): boolean {
  return url === 'about:blank' || url === ORCA_BROWSER_BLANK_URL
}

export function formatBrowserPaletteUrl(url: string): string {
  if (isBlankBrowserUrl(url)) {
    return 'New Tab'
  }
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
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
  a: BrowserPaletteSearchResult,
  b: BrowserPaletteSearchResult
): number {
  if (a.isCurrentPage !== b.isCurrentPage) {
    return a.isCurrentPage ? -1 : 1
  }
  if (a.isCurrentWorktree !== b.isCurrentWorktree) {
    return a.isCurrentWorktree ? -1 : 1
  }
  if (a.score !== b.score) {
    return a.score - b.score
  }
  const secondaryCmp = compareText(a.secondaryText, b.secondaryText)
  if (secondaryCmp !== 0) {
    return secondaryCmp
  }
  return compareText(a.title, b.title)
}

function scoreBrowserPageMatch({
  fieldWeight,
  matchIndex,
  entry
}: {
  fieldWeight: number
  matchIndex: number
  entry: SearchableBrowserPage
}): number {
  let score = fieldWeight + matchIndex + entry.worktreeSortIndex * 100
  if (entry.isCurrentPage) {
    score -= 40
  } else if (entry.isCurrentWorktree) {
    score -= 10
  }
  return score
}

export function searchBrowserPages(
  entries: SearchableBrowserPage[],
  query: string
): BrowserPaletteSearchResult[] {
  const trimmedQuery = query.trim().toLowerCase()
  const results: BrowserPaletteSearchResult[] = []

  for (const entry of entries) {
    const formattedUrl = formatBrowserPaletteUrl(entry.page.url)
    const title = entry.page.title || formattedUrl
    const fallbackSecondaryText = formattedUrl
    const baseResult = {
      pageId: entry.page.id,
      workspaceId: entry.workspace.id,
      worktreeId: entry.worktree.id,
      title,
      workspaceLabel: entry.workspace.label ?? null,
      repoName: entry.repoName,
      worktreeName: entry.worktree.displayName,
      isCurrentPage: entry.isCurrentPage,
      isCurrentWorktree: entry.isCurrentWorktree
    }

    if (!trimmedQuery) {
      results.push({
        ...baseResult,
        secondaryText: fallbackSecondaryText,
        workspaceRange: null,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        // Why: empty-query browser ordering is intentionally deterministic and
        // context-first. The palette should not invent hidden browser recency
        // semantics until Orca explicitly tracks them in state.
        score: entry.isCurrentPage
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
        secondaryText: fallbackSecondaryText,
        workspaceRange: null,
        titleRange,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        score: scoreBrowserPageMatch({
          fieldWeight: 0,
          matchIndex: titleRange.start,
          entry
        })
      })
      continue
    }

    const formattedUrlRange = findRange(formattedUrl, trimmedQuery)
    if (formattedUrlRange) {
      results.push({
        ...baseResult,
        secondaryText: formattedUrl,
        workspaceRange: null,
        titleRange: null,
        secondaryRange: formattedUrlRange,
        repoRange: null,
        worktreeRange: null,
        score: scoreBrowserPageMatch({
          fieldWeight: 20,
          matchIndex: formattedUrlRange.start,
          entry
        })
      })
      continue
    }

    const rawUrlRange = findRange(entry.page.url, trimmedQuery)
    if (rawUrlRange) {
      results.push({
        ...baseResult,
        secondaryText: entry.page.url,
        workspaceRange: null,
        titleRange: null,
        secondaryRange: rawUrlRange,
        repoRange: null,
        worktreeRange: null,
        score: scoreBrowserPageMatch({
          fieldWeight: 24,
          matchIndex: rawUrlRange.start,
          entry
        })
      })
      continue
    }

    const workspaceRange = findRange(entry.workspace.label ?? '', trimmedQuery)
    if (workspaceRange) {
      results.push({
        ...baseResult,
        secondaryText: fallbackSecondaryText,
        workspaceRange,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        score: scoreBrowserPageMatch({
          fieldWeight: 32,
          matchIndex: workspaceRange.start,
          entry
        })
      })
      continue
    }

    const worktreeRange = findRange(entry.worktree.displayName, trimmedQuery)
    if (worktreeRange) {
      results.push({
        ...baseResult,
        secondaryText: fallbackSecondaryText,
        workspaceRange: null,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange,
        score: scoreBrowserPageMatch({
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
        secondaryText: fallbackSecondaryText,
        workspaceRange: null,
        titleRange: null,
        secondaryRange: null,
        repoRange,
        worktreeRange: null,
        score: scoreBrowserPageMatch({
          fieldWeight: 60,
          matchIndex: repoRange.start,
          entry
        })
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
