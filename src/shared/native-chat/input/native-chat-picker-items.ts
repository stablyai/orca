import type { DiscoveredSkill, SkillSourceKind } from '../../skills'
import { locatedPickerSkill, getSafeSkillName, isTokenSafe } from '../../native-chat-reported-skill'
import type { NativeChatSessionSkill, SlashCommandSuggestion } from './native-chat-slash-commands'
import { stripUnsafeDisplayCharacters } from '../../skill-display-text'
import { compareBaseSensitivityLocaleText } from '../../locale-text-collators'

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
      /** The file the agent selects this skill by, when the agent reported it; a pick sends it. */
      path?: string
      /** Distinguishes same-named reported files independently of description or scanner scope. */
      location?: string
    }

export type NativeChatSkillDiscoverySnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  skills: readonly DiscoveredSkill[]
  errorKind?: 'unavailable' | 'timeout' | 'host' | 'unknown'
}

/** Only unclassify namesake commands a scanned skill can replace. Never override host-owned dispatch (/compact).
 * OpenCode 1.x mixes skills into commands: require matching skill descriptions; otherwise its real command takes precedence. */
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
  trigger: '/' | '$' = '/',
  commandAvailable?: (name: string) => boolean
): NativeChatPickerItem[] {
  // Only shared sigils collide: /review and $review remain separate.
  const sharedSigil = skillSigil === '/'
  const unclassifiedNames = new Set(
    commands.filter((command) => command.kindUnspecified).map((command) => command.name)
  )
  const mergedSkills = mergeNativeChatSkills(skills, sessionSkills, unclassifiedNames, skillSigil)
  const skillNames = new Set(mergedSkills.map((skill) => skill.name))
  const available = commandAvailable
    ? commands.filter(({ name }) => commandAvailable(name))
    : commands
  const orcaNames = new Set(available.filter((c) => c.orcaOwned).map((command) => command.name))
  const resolvedCommands = available.filter(
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
        // Curated command names are dispatch tokens; sanitize untrusted skill text only.
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
    const namedSkills = byName.get(safeName) ?? []
    namedSkills.push({ ...skill, name: safeName })
    byName.set(safeName, namedSkills)
  }
  const discovered = new Map(
    [...byName.entries()].map(([name, namedSkills]) => [
      name,
      pickerSkill(name, namedSkills, skillSigil)
    ])
  )
  // Session reports determine loaded skills (including plugin roots/setting-source filters); disk scans enrich matching descriptions/scope only.
  // Each reported file gets its own row so same-named skills remain explicitly selectable.
  const nameCounts = new Map<string, number>()
  const firstReportedByName = new Map<string, NativeChatSessionSkill>()
  for (const skill of sessionSkills ?? []) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1)
    if (!firstReportedByName.has(skill.name)) {
      firstReportedByName.set(skill.name, skill)
    }
  }
  const located = (sessionSkills ?? []).flatMap((skill) =>
    skill.path && isTokenSafe(skill.name)
      ? [
          locatedPickerSkill(
            skill,
            skill.path,
            exactPaths.get(skill.path),
            skillSigil,
            (nameCounts.get(skill.name) ?? 0) > 1
          )
        ]
      : []
  )
  const names =
    sessionSkills !== undefined
      ? [
          ...sessionSkills
            .filter((skill) => !skill.path)
            .map((skill) => skill.name)
            .filter(isTokenSafe),
          ...[...discovered.keys()].filter((name) => unclassifiedNames.has(name))
        ]
      : [...discovered.keys()]
  return [
    ...located,
    ...[...new Set(names)].map((name) => {
      const skill = discovered.get(name) ?? pickerSkill(name, [], skillSigil)
      const reported = firstReportedByName.get(name)?.description
      return skill.description === null && reported
        ? { ...skill, description: sanitizePickerText(reported, 240) }
        : skill
    })
  ].sort(comparePickerSkills)
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
  const normalizedQuery = query.toLowerCase()
  const name = item.name.toLowerCase()
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
  if (matchDescriptions && item.description?.toLowerCase().includes(normalizedQuery)) {
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

// Unlocated reported skills remain invocable but lack description/scope for ranking; sort last.
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
