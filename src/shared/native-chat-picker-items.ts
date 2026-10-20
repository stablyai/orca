import type { DiscoveredSkill, SkillSourceKind } from './skills'
import type { NativeChatSessionSkill, SlashCommandSuggestion } from './native-chat-slash-commands'
import { isSafeDisplayCharacter, stripUnsafeDisplayCharacters } from './skill-display-text'
import { compareBaseSensitivityLocaleText } from './locale-text-collators'

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
      orcaOwned?: true
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

/**
 * Which commands a scanned skill of the same name may stand in for, by marking them unclassified.
 * Never one the chat's own send handles (`/compact`), which runs that whatever the row says. Where
 * the agent's report lists skills among its commands (OpenCode 1.x), only a name reported under
 * that skill's own description; any other is the agent's command, which OpenCode runs first.
 */
export function classifyPickerCommands(
  commands: readonly SlashCommandSuggestion[],
  skills: readonly DiscoveredSkill[],
  options: { reportMayListSkills: boolean; isSendCommand: (name: string) => boolean }
): readonly SlashCommandSuggestion[] {
  const skillDescriptions = options.reportMayListSkills
    ? new Set(skills.map((skill) => `${skill.name}\0${normalizedDescription(skill.description)}`))
    : null
  return commands.map((command) => {
    const unclassified =
      (command.kindUnspecified === true ||
        skillDescriptions?.has(`${command.name}\0${normalizedDescription(command.description)}`) ===
          true) &&
      !options.isSendCommand(command.name)
    if (unclassified === (command.kindUnspecified === true)) {
      return command
    }
    const { kindUnspecified: _dropped, ...classified } = command
    return unclassified ? { ...command, kindUnspecified: true } : classified
  })
}

function normalizedDescription(description: string | null | undefined): string {
  return description?.replace(/\s+/g, ' ').trim() ?? ''
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
  sessionSkills?: readonly NativeChatSessionSkill[],
  /** Rows kept per group; a caller that needs every skill passes Infinity. */
  limit = PICKER_RESULT_LIMIT,
  /** `$` matches skill names only, so a shell word like `$CODEX_HOME` never hits a description. */
  trigger: '/' | '$' = '/'
): NativeChatPickerItem[] {
  // A name can only collide when both kinds invoke through the same sigil;
  // where skills carry their own, `/review` and `$review` are distinct entries.
  const sharedSigil = skillSigil === '/'
  const unclassifiedNames = new Set(
    commands.filter((command) => command.kindUnspecified).map((command) => command.name)
  )
  const mergedSkills = mergeNativeChatSkills(skills, sessionSkills, unclassifiedNames, skillSigil)
  const skillNames = new Set(mergedSkills.map((skill) => skill.name))
  const orcaNames = new Set(commands.filter((c) => c.orcaOwned).map((command) => command.name))
  const resolvedCommands = commands.filter(
    (command) =>
      command.orcaOwned ||
      !(
        orcaNames.has(command.name) ||
        (sharedSigil && command.kindUnspecified && skillNames.has(command.name))
      )
  )
  // Orca runs its own rows whatever the skills are called, so a namesake skill keeps its row.
  const commandNames = new Set(
    resolvedCommands.filter((command) => !command.orcaOwned).map((command) => command.name)
  )
  const commandItems = rankItems(
    resolvedCommands.map((command, index) => ({
      item: {
        kind: 'command' as const,
        // Why: the name is the dispatch token and the catalog is curated, so
        // it is inserted verbatim; only untrusted skill text gets sanitized.
        id: `command:${command.name}`,
        name: command.name,
        token: `/${command.name}`,
        description: command.description ? sanitizePickerText(command.description, 240) : undefined,
        argumentHint: command.argumentHint
          ? sanitizePickerText(command.argumentHint, 80)
          : undefined,
        skillCollision: sharedSigil && !command.orcaOwned && skillNames.has(command.name),
        ...(command.orcaOwned ? { orcaOwned: true as const } : {})
      },
      stableOrder: index
    })),
    query
  )
  const skillItems = rankItems(
    mergedSkills
      .filter((skill) => !(sharedSigil && commandNames.has(skill.name)))
      .map((item, index) => ({ item, stableOrder: index })),
    query,
    trigger === '/'
  )
  return [...commandItems.slice(0, limit), ...skillItems.slice(0, limit)]
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
  // description and scope for the names both know about.
  const names =
    sessionSkills !== undefined
      ? [
          ...sessionSkills.map((skill) => skill.name).filter(isTokenSafe),
          ...[...discovered.keys()].filter((name) => unclassifiedNames.has(name))
        ]
      : [...discovered.keys()]
  return [...new Set(names)]
    .map((name) => {
      const skill = discovered.get(name) ?? pickerSkill(name, [], skillSigil)
      const reported = sessionSkills?.find((entry) => entry.name === name)?.description
      return skill.description === null && reported
        ? { ...skill, description: sanitizePickerText(reported, 240) }
        : skill
    })
    .sort(comparePickerSkills)
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
  query: string,
  matchDescriptions = true
): T[] {
  if (!query) {
    return entries.map((entry) => entry.item)
  }
  return entries
    .map((entry) => ({ ...entry, rank: getMatchRank(entry.item, query, matchDescriptions) }))
    .filter((entry) => entry.rank !== null)
    .sort((a, b) => a.rank! - b.rank! || a.stableOrder - b.stableOrder)
    .map((entry) => entry.item)
}

function getMatchRank(
  item: Pick<NativeChatPickerItem, 'name' | 'description'>,
  query: string,
  matchDescriptions: boolean
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
  if (matchDescriptions && item.description?.toLocaleLowerCase().includes(normalizedQuery)) {
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

// Why: the row's visual truncation is CSS; the name IS the inserted PTY token,
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

// `/` is the composer's trigger for every agent. A draft-leading slash is the one
// that can dispatch; elsewhere the token starts after whitespace and its query
// stops at the next `/` so file paths stay prose.
export const LEADING_SLASH_TRIGGER = /^\/(\S*)$/
export const MID_PROMPT_SLASH_TRIGGER = /\s\/([^\s/]*)$/
// An agent whose skills carry their own sigil (Codex `$`) also opens its skills alone on it.
const SKILL_SIGIL_TRIGGER = /(?:^|\s)\$(\S*)$/
const COMMON_ENV_VARS = new Set(
  'PATH HOME USER SHELL PWD TMPDIR TEMP TMP LANG TERM XDG_CONFIG_HOME'.split(' ')
)

/** The query after a `$` skill sigil at the caret, or null when it reads as shell
 *  syntax (`$HOME`, `$5`, `$(pwd)`, `$?`), by the same rule as Codex's own composer. */
export function matchSkillSigil(before: string): string | null {
  const query = before.match(SKILL_SIGIL_TRIGGER)?.[1] ?? null
  // A bare `$` still opens the full list.
  if (!query) {
    return query
  }
  const name = query.match(/^[\w:-]*/)?.[0] ?? ''
  if (name === '' || name === '_' || /^[-\d]/.test(name)) {
    return null
  }
  // Why: a lowercase spelling stays a skill, so a skill named `home` still completes.
  return !/[a-z]/.test(name) && COMMON_ENV_VARS.has(name.toUpperCase()) ? null : query
}

/** Replaces the typed trigger token with the item's own token, which for a skill
 *  is the agent-native form whichever trigger opened the menu. */
export function applyPickerSuggestion(
  draft: string,
  caret: number,
  item: NativeChatPickerItem
): { draft: string; caret: number; insertedToken: string } {
  const before = draft.slice(0, caret)
  const after = draft.slice(caret)
  const slashMatch = before.match(LEADING_SLASH_TRIGGER) ?? before.match(MID_PROMPT_SLASH_TRIGGER)
  const query = slashMatch?.[1] ?? (item.kind === 'skill' ? matchSkillSigil(before) : null)
  if (query === null) {
    return { draft, caret, insertedToken: '' }
  }
  const tokenStart = before.length - query.length - 1
  const nextBefore = `${before.slice(0, tokenStart)}${item.token} `
  return { draft: nextBefore + after, caret: nextBefore.length, insertedToken: item.token }
}
