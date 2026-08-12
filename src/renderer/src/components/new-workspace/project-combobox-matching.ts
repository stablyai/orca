import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { isNewWorkspaceProjectOptionQueryTooLarge } from '@/lib/new-workspace-project-options'

export type ScoredProjectOption = {
  option: NewWorkspaceProjectOption
  score: number
  nameHits: readonly number[]
  detailHits: readonly number[]
}

function substringHits(text: string, query: string): number[] | null {
  const at = text.toLowerCase().indexOf(query)
  return at === -1 ? null : Array.from({ length: query.length }, (_, offset) => at + offset)
}

/**
 * Verbatim run, else scattered subsequence. Only names get the loose pass —
 * a subsequence over a detail line matches "scr" against "3 hosts configured".
 */
function nameHitsFor(name: string, query: string): number[] | null {
  const verbatim = substringHits(name, query)
  if (verbatim) {
    return verbatim
  }
  const haystack = name.toLowerCase()
  const hits: number[] = []
  let cursor = 0
  for (const char of query) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) {
      return null
    }
    hits.push(found)
    cursor = found + 1
  }
  return hits
}

function nameScore(name: string, hits: readonly number[]): number {
  const first = hits[0] ?? 0
  const contiguous = (hits.at(-1) ?? first) - first === hits.length - 1
  const boundary = first === 0 || /[^a-z0-9]/i.test(name[first - 1] ?? '')
  const base = contiguous ? (first === 0 ? 900 : boundary ? 780 : 700) : 420
  return base - name.length * 0.4
}

/**
 * Ranks options for a query, with recency breaking ties (and ordering the
 * unfiltered list). `recentIds` is most-recent-first.
 */
export function rankProjectOptions(
  options: readonly NewWorkspaceProjectOption[],
  rawQuery: string,
  recentIds: readonly string[]
): ScoredProjectOption[] {
  if (isNewWorkspaceProjectOptionQueryTooLarge(rawQuery)) {
    return []
  }
  const query = rawQuery.trim().toLowerCase()
  const scored: ScoredProjectOption[] = []
  for (const option of options) {
    const recentAt = recentIds.indexOf(option.id)
    const recency = recentAt === -1 ? 0 : 32 - recentAt * 4
    if (query.length === 0) {
      scored.push({ option, score: recency, nameHits: [], detailHits: [] })
      continue
    }
    const nameHits = nameHitsFor(option.displayName, query)
    const detailHits = substringHits(option.detail, query)
    if (!nameHits && !detailHits) {
      continue
    }
    scored.push({
      option,
      score: (nameHits ? nameScore(option.displayName, nameHits) : 260) + recency,
      nameHits: nameHits ?? [],
      detailHits: detailHits ?? []
    })
  }
  return scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.option.displayName.localeCompare(b.option.displayName) ||
      a.option.detail.localeCompare(b.option.detail)
  )
}

export type ProjectOptionSection = {
  key: 'recent' | 'projects' | 'folders' | 'results'
  heading: string | null
  items: ScoredProjectOption[]
}

/** Below this a list is scannable, so sections are chrome rather than help. */
const SECTION_THRESHOLD = 6
const RECENT_LIMIT = 4

/**
 * While a query is live the ranking *is* the order, so sections would fight it:
 * everything collapses into one unlabelled result list.
 */
export function sectionProjectOptions(
  matches: readonly ScoredProjectOption[],
  query: string,
  recentIds: readonly string[]
): ProjectOptionSection[] {
  if (query.trim() !== '' || matches.length < SECTION_THRESHOLD) {
    return [{ key: 'results', heading: null, items: [...matches] }]
  }
  const recentSet = new Set(
    recentIds.filter((id) => matches.some((m) => m.option.id === id)).slice(0, RECENT_LIMIT)
  )
  const recent = recentIds.flatMap((id) =>
    recentSet.has(id) ? matches.filter((m) => m.option.id === id) : []
  )
  const sections: ProjectOptionSection[] = [
    { key: 'recent', heading: 'Recent', items: recent },
    {
      key: 'projects',
      heading: 'Projects',
      items: matches.filter((m) => m.option.kind === 'project' && !recentSet.has(m.option.id))
    },
    {
      key: 'folders',
      heading: 'Folders',
      // Same recent exclusion as Projects: a row must appear in exactly one
      // section, or arming and rendering see two rows for one option.
      items: matches.filter((m) => m.option.kind === 'project-group' && !recentSet.has(m.option.id))
    }
  ]
  return sections.filter((section) => section.items.length > 0)
}

/** Ids whose displayName repeats — those rows can't be read by name alone. */
export function getAmbiguousProjectOptionIds(
  options: readonly NewWorkspaceProjectOption[]
): Set<string> {
  const counts = new Map<string, number>()
  for (const option of options) {
    counts.set(option.displayName, (counts.get(option.displayName) ?? 0) + 1)
  }
  return new Set(
    options.filter((o) => (counts.get(o.displayName) ?? 0) > 1).map((option) => option.id)
  )
}

/**
 * A deep path's identity lives in its tail (`…/services/checkout-api`), which is
 * exactly what a plain truncate throws away — two sibling paths then render
 * identically. Split so the head can elide while the tail keeps its width.
 */
export function splitDetailForElision(detail: string): { head: string; tail: string } | null {
  const segments = detail.split('/')
  if (segments.length <= 3 || detail.length <= 28) {
    return null
  }
  return { head: segments.slice(0, -2).join('/'), tail: segments.slice(-2).join('/') }
}
