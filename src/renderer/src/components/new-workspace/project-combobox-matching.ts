import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { isNewWorkspaceProjectOptionQueryTooLarge } from '@/lib/new-workspace-project-options'
import { translate } from '@/i18n/i18n'

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

/** Allow loose subsequences only in names; detail text would create noisy matches such as scr in hosts configured. */
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

/** Rank matches with most-recent-first IDs breaking ties and ordering empty queries. */
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

/** Use one unlabelled list while searching so sections cannot reorder ranked results. */
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
    {
      key: 'recent',
      heading: translate('auto.components.new.workspace.projectCombobox.recentHeading', 'Recent'),
      items: recent
    },
    {
      key: 'projects',
      heading: translate(
        'auto.components.new.workspace.projectCombobox.projectsHeading',
        'Projects'
      ),
      items: matches.filter((m) => m.option.kind === 'project' && !recentSet.has(m.option.id))
    },
    {
      key: 'folders',
      heading: translate('auto.components.new.workspace.projectCombobox.foldersHeading', 'Folders'),
      // Exclude recent rows from folders too; duplicate options would desynchronize arming/rendering.
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
