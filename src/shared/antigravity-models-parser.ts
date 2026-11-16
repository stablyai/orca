import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from './agent-session/agent-session-wire'
import { stripAnsiEscapeSequences } from './terminal/protocol/escape/ansi-escape-sequences'
import type {
  CommitMessageModel,
  ThinkingLevel
} from './source-control/ai/generation/commit-message-agent-spec'

export const ANTIGRAVITY_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AntigravityEffortId = (typeof ANTIGRAVITY_EFFORT_ORDER)[number]

const ACP_EFFORT_CHOICE: Record<AntigravityEffortId, AgentSessionOptionChoice> = {
  low: { value: 'low', label: 'Low' },
  medium: { value: 'medium', label: 'Medium' },
  high: { value: 'high', label: 'High' },
  xhigh: { value: 'xhigh', label: 'Extra high' },
  max: { value: 'max', label: 'Max' }
}

const COMMIT_THINKING_LEVEL: Record<AntigravityEffortId, ThinkingLevel> = {
  low: { id: 'low', label: 'Low' },
  medium: { id: 'medium', label: 'Medium' },
  high: { id: 'high', label: 'High' },
  xhigh: { id: 'xhigh', label: 'Extra High' },
  max: { id: 'max', label: 'Max' }
}

type RawAntigravityModelRow = {
  id: string
  label: string
  /** Older `agy` releases print display names with spaces; those never collapse by `-effort`. */
  displayNameOnly: boolean
}

export type ParsedAntigravityModel = {
  id: string
  label: string
  efforts: AntigravityEffortId[]
}

const LEGACY_DISPLAY_NAME_RE = /^.+ \((?:low|medium|high|xhigh|extra\s+high|max|thinking)\)$/i
const EFFORT_SUFFIX_RE = /^(.*)-(low|medium|high|xhigh|max)$/i
const TRAILING_EFFORT_LABEL_RE = /\s*\((?:low|medium|high|xhigh|extra\s+high|max)\)\s*$/i

function* iterateOutputLines(output: string): Generator<string> {
  let lineStart = 0
  for (let index = 0; index < output.length; index++) {
    const code = output.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }
    yield output.slice(lineStart, index)
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index++
    }
    lineStart = index + 1
  }
  if (lineStart <= output.length) {
    yield output.slice(lineStart)
  }
}

function parseRawAntigravityRows(stdout: string): RawAntigravityModelRow[] {
  const rows: RawAntigravityModelRow[] = []
  const seen = new Set<string>()
  for (const rawLine of iterateOutputLines(stdout)) {
    const line = stripAnsiEscapeSequences(rawLine).trim()
    if (!line) {
      continue
    }
    const tabIndex = line.indexOf('\t')
    const spacesMatch = tabIndex === -1 ? /\s{2,}/.exec(line) : null
    if (tabIndex !== -1 || spacesMatch) {
      const id = (
        tabIndex !== -1 ? line.slice(0, tabIndex) : line.slice(0, spacesMatch!.index)
      ).trim()
      const label = (
        tabIndex !== -1
          ? line.slice(tabIndex + 1)
          : line.slice(spacesMatch!.index + spacesMatch![0].length)
      ).trim()
      if (!id || !label || /\s/.test(id) || /^(?:id|model)$/i.test(id)) {
        continue
      }
      if (seen.has(id)) {
        continue
      }
      seen.add(id)
      rows.push({ id, label, displayNameOnly: false })
      continue
    }
    // Older agy versions list display names like `Gemini 3.8 Flash (High)`.
    if (!LEGACY_DISPLAY_NAME_RE.test(line) || seen.has(line)) {
      continue
    }
    seen.add(line)
    rows.push({ id: line, label: line, displayNameOnly: true })
  }
  return rows
}

function baseLabelForFamily(
  entries: readonly RawAntigravityModelRow[],
  fallbackId: string
): string {
  for (const entry of entries) {
    const stripped = entry.label.replace(TRAILING_EFFORT_LABEL_RE, '').trim()
    if (stripped) {
      return stripped
    }
  }
  return entries[0]?.label || fallbackId
}

function parseAntigravityEffort(raw: string | undefined): AntigravityEffortId | undefined {
  const lower = raw?.toLowerCase()
  return ANTIGRAVITY_EFFORT_ORDER.find((effort) => effort === lower)
}

/** Collapse `<family>-<effort>` variants only when >= 2 distinct efforts share the same family. */
export function parseAntigravityModelList(stdout: string): ParsedAntigravityModel[] {
  const rows = parseRawAntigravityRows(stdout)
  type FamilyBucket = {
    familyId: string
    entries: { row: RawAntigravityModelRow; effort: AntigravityEffortId }[]
  }
  const families = new Map<string, FamilyBucket>()
  const items: (
    | { kind: 'family'; bucket: FamilyBucket }
    | { kind: 'single'; row: RawAntigravityModelRow }
  )[] = []

  for (const row of rows) {
    const match = !row.displayNameOnly ? EFFORT_SUFFIX_RE.exec(row.id) : null
    const familyId = match?.[1]
    const effort = parseAntigravityEffort(match?.[2])
    if (!familyId || !effort) {
      items.push({ kind: 'single', row })
      continue
    }
    let bucket = families.get(familyId)
    if (!bucket) {
      bucket = { familyId, entries: [] }
      families.set(familyId, bucket)
      items.push({ kind: 'family', bucket })
    }
    bucket.entries.push({ row, effort })
  }

  const parsed: ParsedAntigravityModel[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (item.kind === 'single') {
      if (!seen.has(item.row.id)) {
        seen.add(item.row.id)
        parsed.push({ id: item.row.id, label: item.row.label, efforts: [] })
      }
      continue
    }
    const distinctEfforts = new Set(item.bucket.entries.map((entry) => entry.effort))
    if (distinctEfforts.size >= 2) {
      if (!seen.has(item.bucket.familyId)) {
        seen.add(item.bucket.familyId)
        const efforts = ANTIGRAVITY_EFFORT_ORDER.filter((effort) => distinctEfforts.has(effort))
        parsed.push({
          id: item.bucket.familyId,
          label: baseLabelForFamily(
            item.bucket.entries.map((entry) => entry.row),
            item.bucket.familyId
          ),
          efforts
        })
      }
      continue
    }
    // Single-variant suffixed models (e.g. `gpt-oss-120b-medium`) stay standalone without `--effort`.
    for (const entry of item.bucket.entries) {
      if (!seen.has(entry.row.id)) {
        seen.add(entry.row.id)
        parsed.push({ id: entry.row.id, label: entry.row.label, efforts: [] })
      }
    }
  }
  return parsed
}

export function parseAntigravityAcpModels(stdout: string): AgentSessionModelOption[] {
  return parseAntigravityModelList(stdout).map((model) => ({
    id: model.id,
    label: model.label,
    isDefault: false,
    efforts: model.efforts.map((effort) => ACP_EFFORT_CHOICE[effort])
  }))
}

export function parseAntigravityCommitModels(stdout: string): CommitMessageModel[] {
  return parseAntigravityModelList(stdout).map((model) => {
    const thinkingLevels = model.efforts.map((effort) => COMMIT_THINKING_LEVEL[effort])
    return {
      id: model.id,
      label: model.label,
      ...(thinkingLevels.length > 0
        ? {
            thinkingLevels,
            defaultThinkingLevel: thinkingLevels.some((level) => level.id === 'low')
              ? 'low'
              : thinkingLevels[0].id
          }
        : {})
    }
  })
}
