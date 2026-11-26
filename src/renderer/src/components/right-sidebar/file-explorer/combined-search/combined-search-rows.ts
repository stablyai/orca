import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import type { SearchRow } from '../content-search/search-rows'
import type { NameMatch, NameMatchResults } from './name-match-results'

export const TEXT_MATCH_COUNT_CAP = 1000
export const COMBINED_SEARCH_LISTBOX_ID = 'file-explorer-combined-search-results'

export function getCombinedSearchOptionId(index: number): string {
  return `${COMBINED_SEARCH_LISTBOX_ID}-${index}`
}

export type CombinedSearchHeadRow =
  | { type: 'section'; section: 'files' | 'text'; count: string }
  | { type: 'name'; match: NameMatch }
  | { type: 'show-all'; total: number }
  | { type: 'no-results' }
  | { type: 'error'; section: 'files' | 'text'; message: string; muted?: boolean }
  /** A capped source returned no rows it can show; more specific text would find them. */
  | { type: 'refine'; section: 'files' | 'text' }

export type CombinedSearchRow = CombinedSearchHeadRow | SearchRow

export type CombinedSearchRowModel = {
  count: number
  getRow: (index: number) => CombinedSearchRow | undefined
  getKey: (index: number) => string
}

export function formatTextMatchCount(
  result: Pick<SearchResult, 'totalMatches' | 'truncated'>
): string {
  if (result.totalMatches >= TEXT_MATCH_COUNT_CAP) {
    return `${TEXT_MATCH_COUNT_CAP}+`
  }
  return result.truncated ? `${result.totalMatches}+` : String(result.totalMatches)
}

/** Names lead; text rows stay in their own array so a keystroke never copies thousands of match rows. */
export function createCombinedSearchRows({
  names,
  textResult,
  textRows,
  textPending,
  namesError = null,
  textError = null,
  textNotice = null
}: {
  /** null while the name listing is still loading. */
  names: (NameMatchResults & { truncated?: boolean }) | null
  /** null when text search has nothing current to show. */
  textResult: SearchResult | null
  textRows: readonly SearchRow[]
  /** A text search for this query is debouncing or running. */
  textPending: boolean
  namesError?: string | null
  textError?: string | null
  /** A known limit (scan skipped), shown muted rather than as a failure. */
  textNotice?: string | null
}): CombinedSearchRowModel {
  const head: CombinedSearchHeadRow[] = []
  if (namesError) {
    head.push({ type: 'section', section: 'files', count: '' })
    head.push({ type: 'error', section: 'files', message: namesError })
  } else if (names && names.total === 0 && names.truncated) {
    // An empty section shows no count; '0+' would read as nonsense next to the refine hint.
    head.push({ type: 'section', section: 'files', count: '' })
    head.push({ type: 'refine', section: 'files' })
  } else if (names && names.total > 0) {
    head.push({
      type: 'section',
      section: 'files',
      count: names.truncated ? `${names.total}+` : String(names.total)
    })
    for (const match of names.matches) {
      head.push({ type: 'name', match })
    }
    if (names.total > names.matches.length) {
      head.push({ type: 'show-all', total: names.total })
    }
  }
  const textMessage = textError ?? textNotice
  const tail = !textMessage && textResult && textRows.length > 0 ? textRows : []
  if (textMessage) {
    head.push({ type: 'section', section: 'text', count: '' })
    head.push({ type: 'error', section: 'text', message: textMessage, muted: !textError })
  } else if (tail.length > 0 && textResult) {
    head.push({ type: 'section', section: 'text', count: formatTextMatchCount(textResult) })
  } else if (textResult?.truncated) {
    head.push({ type: 'section', section: 'text', count: '' })
    head.push({ type: 'refine', section: 'text' })
  } else if (textPending) {
    // Keep the header while a scan runs so the section never vanishes and nudges rows below it.
    head.push({ type: 'section', section: 'text', count: '' })
  }
  // A capped or still-loading source may hide matches, so only a settled, complete miss says No results.
  if (head.length === 0 && names !== null && !names.truncated && !textPending) {
    head.push({ type: 'no-results' })
  }
  const headCount = head.length
  return {
    count: headCount + tail.length,
    getRow: (index) => (index < headCount ? head[index] : tail[index - headCount]),
    getKey: (index) => {
      const row = index < headCount ? head[index] : tail[index - headCount]
      return row ? getCombinedSearchRowKey(row) : `missing:${index}`
    }
  }
}

export function getCombinedSearchRowKey(row: CombinedSearchRow): string {
  switch (row.type) {
    case 'section':
      return `section:${row.section}`
    case 'name':
      return `name:${row.match.relativePath}`
    case 'show-all':
      return 'show-all'
    case 'no-results':
      return 'no-results'
    case 'error':
      return `error:${row.section}`
    case 'refine':
      return `refine:${row.section}`
    case 'file':
      return `file:${row.fileResult.filePath}`
    case 'match':
      return `match:${row.fileResult.filePath}:${row.match.line}:${row.match.column}:${row.matchIndex}`
  }
}

export function isSelectableCombinedSearchRow(row: CombinedSearchRow | undefined): boolean {
  return (
    row !== undefined &&
    (row.type === 'name' || row.type === 'show-all' || row.type === 'file' || row.type === 'match')
  )
}

export function findSelectableCombinedSearchIndex(
  model: CombinedSearchRowModel,
  from: number,
  direction: 1 | -1
): number {
  for (let index = from; index >= 0 && index < model.count; index += direction) {
    if (isSelectableCombinedSearchRow(model.getRow(index))) {
      return index
    }
  }
  return -1
}

/** Resolves the highlighted row: the remembered key while it still exists, else the first result. */
export function resolveActiveCombinedSearchIndex(
  model: CombinedSearchRowModel,
  activeKey: string | null
): number {
  if (activeKey !== null) {
    for (let index = 0; index < model.count; index += 1) {
      if (model.getKey(index) === activeKey) {
        return index
      }
    }
  }
  return findSelectableCombinedSearchIndex(model, 0, 1)
}

/** Arrow keys stop at either end instead of wrapping, matching the tree. */
export function moveActiveCombinedSearchIndex(
  model: CombinedSearchRowModel,
  activeIndex: number,
  delta: 1 | -1
): number {
  if (activeIndex < 0) {
    return findSelectableCombinedSearchIndex(model, delta === 1 ? 0 : model.count - 1, delta)
  }
  const next = findSelectableCombinedSearchIndex(model, activeIndex + delta, delta)
  return next === -1 ? activeIndex : next
}
