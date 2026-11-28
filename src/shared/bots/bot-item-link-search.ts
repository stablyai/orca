import { botItemWorkerState, type BotItemLinkRow } from './bot-item-link-rows'

/** The kinds a Links list filters by; web links and automations show only under all. */
export type BotItemLinkKind = 'workers' | 'prs' | 'files'
export type BotItemLinkFilter = 'all' | BotItemLinkKind
export const BOT_ITEM_LINK_KINDS: readonly BotItemLinkKind[] = ['workers', 'prs', 'files']

function botItemLinkKind(row: BotItemLinkRow): BotItemLinkKind | null {
  switch (row.kind) {
    case 'worker':
      return 'workers'
    case 'github':
      return row.type === 'pr' ? 'prs' : null
    case 'server-pr':
      return 'prs'
    case 'file':
      return 'files'
    case 'web':
    case 'automation':
      return null
  }
}

type BotItemLinkSearchEntry = {
  row: BotItemLinkRow
  kind: BotItemLinkKind | null
  text: string
}

type LinkCounts = Record<BotItemLinkFilter, number>
type LinkSearchIndex = { entries: BotItemLinkSearchEntry[]; counts: LinkCounts }

function searchFields(row: BotItemLinkRow): (string | null | undefined)[] {
  switch (row.kind) {
    case 'worker':
      return [
        row.link.title,
        row.link.ref,
        row.link.state,
        botItemWorkerState(row.link.state),
        row.link.report?.subject
      ]
    case 'github':
      return [row.title, `#${row.number}`, `${row.repo}#${row.number}`, row.state, row.type]
    case 'server-pr':
      return ['pr']
    case 'web':
      return [row.title, row.url]
    case 'file':
      return [row.name, row.path]
    case 'automation':
      return [row.name]
  }
}

/** Built once per list: name or title, PR or issue number, repo, file name and path, state words.
 *  `words` adds what the row says in the UI's language, e.g. a worker's "Failed". */
export function botItemLinkSearchIndex(
  rows: readonly BotItemLinkRow[],
  words: (row: BotItemLinkRow) => string = () => ''
): LinkSearchIndex {
  const counts: LinkCounts = { all: rows.length, workers: 0, prs: 0, files: 0 }
  const entries = rows.map((row) => {
    const kind = botItemLinkKind(row)
    if (kind) {
      counts[kind] += 1
    }
    return {
      row,
      kind,
      text: [...searchFields(row), words(row)].filter(Boolean).join('\n').toLowerCase()
    }
  })
  return { entries, counts }
}

type BotItemLinkSearchResult = {
  /** The rows under the picked filter that match every word of the query, in the list's order. */
  rows: BotItemLinkRow[]
  /** How many rows match the query under each filter. */
  counts: LinkCounts
}

/** One pass over the index: no sort, so the order stays the list's. */
export function botItemLinkSearch(
  index: LinkSearchIndex,
  query: string,
  filter: BotItemLinkFilter
): BotItemLinkSearchResult {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const counts: LinkCounts = { all: 0, workers: 0, prs: 0, files: 0 }
  const rows: BotItemLinkRow[] = []
  for (const entry of index.entries) {
    if (!terms.every((term) => entry.text.includes(term))) {
      continue
    }
    counts.all += 1
    if (entry.kind) {
      counts[entry.kind] += 1
    }
    if (filter === 'all' || entry.kind === filter) {
      rows.push(entry.row)
    }
  }
  return { rows, counts }
}
