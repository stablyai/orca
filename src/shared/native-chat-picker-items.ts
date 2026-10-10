import type { DiscoveredSkill, SkillSourceKind } from './skills'
import type { SlashCommandSuggestion } from './native-chat-slash-commands'
import { isSafeDisplayCharacter, stripUnsafeDisplayCharacters } from './skill-display-text'
import { compareBaseSensitivityLocaleText } from './locale-text-collation'

// The `/` menu's row policy, shared so the desktop composer and the phone build
// the same grouped, ranked, collision-aware rows from the same catalog.

/** A skill the running session reported, with the description it gave. */
export type NativeChatSessionSkill = { name: string; description?: string }

export type NativeChatPickerItem =
  | {
      kind: 'command'
      id: string
      name: string
      /** Exactly what a pick inserts — the form the agent invokes. */
      token: string
      description?: string
      /** How the provider says the command is invoked, e.g. `<objective>`. */
      argumentHint?: string
      skillCollision: boolean
    }
  | {
      kind: 'skill'
      id: string
      name: string
      token: string
      description: string | null
      sources: { sourceKind: SkillSourceKind; skillFilePath: string }[]
    }

export type NativeChatSkillDiscoverySnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  skills: readonly DiscoveredSkill[]
  errorKind?: 'unavailable' | 'timeout' | 'host' | 'unknown'
}

const PICKER_RESULT_LIMIT = 50
const SCOPE_PRIORITY: Record<SkillSourceKind, number> = {
  repo: 0,
  home: 1,
  bundled: 2,
  plugin: 3
}

export function buildNativeChatPickerItems(
  commands: readonly SlashCommandSuggestion[],
  skills: readonly DiscoveredSkill[],
  query: string,
  skillSigil: '/' | '$',
  sessionSkills?: readonly NativeChatSessionSkill[]
): NativeChatPickerItem[] {
  // A name can only collide when both kinds invoke through the same sigil;
  // where skills carry their own, `/review` and `$review` are distinct entries.
  const sharedSigil = skillSigil === '/'
  const unclassifiedNames = new Set(
    commands.filter((command) => command.kindUnspecified).map((command) => command.name)
  )
  const mergedSkills = mergeNativeChatSkills(skills, sessionSkills, unclassifiedNames, skillSigil)
  const skillNames = new Set(mergedSkills.map((skill) => skill.name))
  // Why: a session-reported name is untrusted; one with whitespace or hidden
  // characters would insert text the row never shows, so it gets no row.
  const resolvedCommands = commands.filter(
    (command) =>
      isTokenSafe(command.name) &&
      !(sharedSigil && command.kindUnspecified && skillNames.has(command.name))
  )
  const commandNames = new Set(resolvedCommands.map((command) => command.name))
  const commandItems = rankItems(
    resolvedCommands.map((command, index) => ({
      item: {
        kind: 'command' as const,
        // Why: the name is the dispatch token, so it is never altered; unsafe names were dropped above.
        id: `command:${command.name}`,
        name: command.name,
        token: `/${command.name}`,
        description: command.description ? sanitizePickerText(command.description, 240) : undefined,
        argumentHint: command.argumentHint
          ? sanitizePickerText(command.argumentHint, 80)
          : undefined,
        skillCollision: sharedSigil && skillNames.has(command.name)
      },
      stableOrder: index
    })),
    query
  )
  const skillItems = rankItems(
    mergedSkills
      .filter((skill) => !(sharedSigil && commandNames.has(skill.name)))
      .map((item, index) => ({ item, stableOrder: index })),
    query
  )
  return [
    ...commandItems.slice(0, PICKER_RESULT_LIMIT),
    ...skillItems.slice(0, PICKER_RESULT_LIMIT)
  ]
}

function mergeNativeChatSkills(
  skills: readonly DiscoveredSkill[],
  sessionSkills: readonly NativeChatSessionSkill[] | undefined,
  unclassifiedNames: ReadonlySet<string>,
  skillSigil: '/' | '$'
): Extract<NativeChatPickerItem, { kind: 'skill' }>[] {
  const exactPaths = new Map<string, DiscoveredSkill>()
  for (const skill of skills) {
    if (skill.installed && !exactPaths.has(skill.skillFilePath)) {
      exactPaths.set(skill.skillFilePath, skill)
    }
  }
  const byName = new Map<string, DiscoveredSkill[]>()
  for (const skill of exactPaths.values()) {
    const safeName = getSafeSkillName(skill)
    if (!safeName) {
      continue
    }
    byName.set(safeName, [...(byName.get(safeName) ?? []), { ...skill, name: safeName }])
  }
  const discovered = new Map(
    [...byName.entries()].map(([name, namedSkills]) => [
      name,
      pickerSkill(name, namedSkills, skillSigil)
    ])
  )
  // Why: when the running session reports its own skills, that report is the
  // authority on which ones exist — a disk scan cannot see what the session
  // actually loaded (plugin roots, setting-source filters), and a scanned root
  // the session ignored must not be offered. The scan stays the source of
  // scope (and of description, where it has one) for the names both know about.
  const reportedDescriptions = new Map(
    (sessionSkills ?? []).map((skill) => [skill.name, skill.description])
  )
  const names =
    sessionSkills !== undefined
      ? [
          ...sessionSkills.map((skill) => skill.name).filter(isTokenSafe),
          ...[...discovered.keys()].filter((name) => unclassifiedNames.has(name))
        ]
      : [...discovered.keys()]
  return [...new Set(names)]
    .map((name) =>
      withReportedDescription(
        discovered.get(name) ?? pickerSkill(name, [], skillSigil),
        reportedDescriptions.get(name)
      )
    )
    .sort(comparePickerSkills)
}

// The scan's description wins; the session's own covers skills the scan lacks.
function withReportedDescription(
  item: Extract<NativeChatPickerItem, { kind: 'skill' }>,
  reported: string | undefined
): Extract<NativeChatPickerItem, { kind: 'skill' }> {
  return item.description !== null || !reported
    ? item
    : { ...item, description: sanitizePickerText(reported, 240) }
}

function pickerSkill(
  name: string,
  namedSkills: readonly DiscoveredSkill[],
  skillSigil: '/' | '$'
): Extract<NativeChatPickerItem, { kind: 'skill' }> {
  const sorted = [...namedSkills].sort(compareDiscoveredSkills)
  return {
    kind: 'skill' as const,
    id: `skill:${name}`,
    name,
    token: `${skillSigil}${name}`,
    description: sorted[0]?.description ? sanitizePickerText(sorted[0].description, 240) : null,
    sources: sorted.map((skill) => ({
      sourceKind: skill.sourceKind,
      skillFilePath: skill.skillFilePath
    }))
  }
}

function rankItems<T extends NativeChatPickerItem>(
  entries: { item: T; stableOrder: number }[],
  query: string
): T[] {
  if (!query) {
    return entries.map((entry) => entry.item)
  }
  return entries
    .map((entry) => ({ ...entry, rank: getMatchRank(entry.item, query) }))
    .filter((entry) => entry.rank !== null)
    .sort((a, b) => a.rank! - b.rank! || a.stableOrder - b.stableOrder)
    .map((entry) => entry.item)
}

function getMatchRank(
  item: Pick<NativeChatPickerItem, 'name' | 'description'>,
  query: string
): number | null {
  const normalizedQuery = query.toLocaleLowerCase()
  const name = item.name.toLocaleLowerCase()
  if (name === normalizedQuery) {
    return 0
  }
  if (name.startsWith(normalizedQuery)) {
    return 1
  }
  if (name.includes(normalizedQuery)) {
    return 2
  }
  if (isSubsequence(normalizedQuery, name)) {
    return 3
  }
  if (item.description?.toLocaleLowerCase().includes(normalizedQuery)) {
    return 4
  }
  return null
}

function isSubsequence(query: string, value: string): boolean {
  let queryIndex = 0
  for (const character of value) {
    if (character === query[queryIndex]) {
      queryIndex += 1
    }
    if (queryIndex === query.length) {
      return true
    }
  }
  return false
}

// Why: the row truncates visually; the name IS the inserted PTY token,
// so it must never be sliced. Token safety instead rejects absurd lengths.
const MAX_TOKEN_SAFE_NAME_LENGTH = 200

function getSafeSkillName(skill: DiscoveredSkill): string | null {
  if (isTokenSafe(skill.name)) {
    return skill.name
  }
  const directoryName = skill.directoryPath.split(/[\\/]/).findLast(Boolean) ?? ''
  return isTokenSafe(directoryName) ? directoryName : null
}

function isTokenSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_TOKEN_SAFE_NAME_LENGTH &&
    !/\s/u.test(value) &&
    [...value].every(isSafeDisplayCharacter)
  )
}

function sanitizePickerText(value: string, maxLength: number): string {
  return stripUnsafeDisplayCharacters(value).slice(0, maxLength)
}

function compareDiscoveredSkills(a: DiscoveredSkill, b: DiscoveredSkill): number {
  return (
    SCOPE_PRIORITY[a.sourceKind] - SCOPE_PRIORITY[b.sourceKind] ||
    compareBaseSensitivityLocaleText(a.name, b.name) ||
    a.skillFilePath.localeCompare(b.skillFilePath)
  )
}

// A session-reported skill this host could not locate on disk sorts last: it is
// real and invocable, but carries no scope or description to rank on.
const UNLOCATED_SCOPE_PRIORITY = Object.keys(SCOPE_PRIORITY).length

function skillScopePriority(item: Extract<NativeChatPickerItem, { kind: 'skill' }>): number {
  const sourceKind = item.sources[0]?.sourceKind
  return sourceKind === undefined ? UNLOCATED_SCOPE_PRIORITY : SCOPE_PRIORITY[sourceKind]
}

function comparePickerSkills(
  a: Extract<NativeChatPickerItem, { kind: 'skill' }>,
  b: Extract<NativeChatPickerItem, { kind: 'skill' }>
): number {
  return (
    skillScopePriority(a) - skillScopePriority(b) ||
    compareBaseSensitivityLocaleText(a.name, b.name)
  )
}
