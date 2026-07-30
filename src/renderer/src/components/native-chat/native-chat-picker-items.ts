import type { DiscoveredSkill, SkillSourceKind } from '../../../../shared/skills'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import {
  isSafeDisplayCharacter,
  stripUnsafeDisplayCharacters
} from '../../../../shared/skill-display-text'

export type NativeChatPickerItem =
  | {
      kind: 'command'
      id: string
      name: string
      description?: string
      skillCollision: boolean
    }
  | {
      kind: 'skill'
      id: string
      name: string
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
  prefix: '/' | '$'
): NativeChatPickerItem[] {
  const mergedSkills = mergeNativeChatSkills(skills)
  const skillNames = new Set(mergedSkills.map((skill) => skill.name))
  const commandNames = new Set(commands.map((command) => command.name))
  const commandItems = rankItems(
    commands.map((command, index) => ({
      item: {
        kind: 'command' as const,
        // Why: the name is the dispatch token and the catalog is curated, so
        // it is inserted verbatim; only untrusted skill text gets sanitized.
        id: `command:${command.name}`,
        name: command.name,
        description: command.description ? sanitizePickerText(command.description, 240) : undefined,
        skillCollision: prefix === '/' && skillNames.has(command.name)
      },
      stableOrder: index
    })),
    query
  )
  const skillItems = rankItems(
    mergedSkills
      .filter((skill) => !(prefix === '/' && commandNames.has(skill.name)))
      .map((item, index) => ({ item, stableOrder: index })),
    query
  )
  return [
    ...commandItems.slice(0, PICKER_RESULT_LIMIT),
    ...skillItems.slice(0, PICKER_RESULT_LIMIT)
  ]
}

function mergeNativeChatSkills(
  skills: readonly DiscoveredSkill[]
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
  return [...byName.entries()]
    .map(([name, namedSkills]) => {
      const sorted = [...namedSkills].sort(compareDiscoveredSkills)
      return {
        kind: 'skill' as const,
        id: `skill:${name}`,
        name,
        description: sorted[0]?.description ? sanitizePickerText(sorted[0].description, 240) : null,
        sources: sorted.map((skill) => ({
          sourceKind: skill.sourceKind,
          skillFilePath: skill.skillFilePath
        }))
      }
    })
    .sort(comparePickerSkills)
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
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.skillFilePath.localeCompare(b.skillFilePath)
  )
}

function comparePickerSkills(
  a: Extract<NativeChatPickerItem, { kind: 'skill' }>,
  b: Extract<NativeChatPickerItem, { kind: 'skill' }>
): number {
  return (
    SCOPE_PRIORITY[a.sources[0].sourceKind] - SCOPE_PRIORITY[b.sources[0].sourceKind] ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
}

export function applyPickerSuggestion(
  draft: string,
  caret: number,
  item: NativeChatPickerItem,
  prefix: '/' | '$'
): { draft: string; caret: number; insertedToken: string } {
  const before = draft.slice(0, caret)
  const after = draft.slice(caret)
  const match = prefix === '/' ? before.match(/^\/(\S*)$/) : before.match(/(^|\s)\$(\S*)$/)
  if (!match) {
    return { draft, caret, insertedToken: '' }
  }
  const query = match.at(-1) ?? ''
  const tokenStart = before.length - query.length - 1
  const insertedToken = `${prefix}${item.name}`
  const nextBefore = `${before.slice(0, tokenStart)}${insertedToken} `
  return { draft: nextBefore + after, caret: nextBefore.length, insertedToken }
}

export type NativeChatSendClassification = 'chat' | 'command' | 'unknown-token'

export function classifyNativeChatSend(
  draft: string,
  commands: readonly SlashCommandSuggestion[],
  pickerSkillOriginToken: string | null,
  skillPrefix: '/' | '$' | null
): NativeChatSendClassification {
  // Why: the supported TUIs only treat a line-leading token as a command, so a
  // draft with leading whitespace is prose; trimming here would claim a "Ran"
  // line for text the agent never dispatched.
  const firstToken = draft.split(/\s/, 1)[0] ?? ''
  if (pickerSkillOriginToken && firstToken === pickerSkillOriginToken) {
    return 'chat'
  }
  if (commands.some((command) => firstToken === `/${command.name}`)) {
    return 'command'
  }
  if (firstToken.startsWith('/')) {
    return 'unknown-token'
  }
  // Why: `$` is Codex grammar only. For other agents a leading `$PATH`-style
  // token is ordinary prose and must keep its bubble and attachments.
  if (skillPrefix === '$' && firstToken.startsWith('$')) {
    return 'unknown-token'
  }
  return 'chat'
}
