import type { DiscoveredSkill } from './skills'
import { formatNativeChatFileReference } from './agent-image-paste'
import type { NativeChatAgentProfile } from './native-chat-agent-profiles'
import {
  filterSlashCommands,
  isSlashCommandDraft,
  applySlashSuggestion,
  slashCommandDispatchText,
  type NativeChatSessionSkill,
  type SlashCommandSuggestion
} from './native-chat/input/native-chat-slash-commands'
import {
  buildNativeChatPickerItems,
  type NativeChatPickerItem,
  type NativeChatSkillDiscoverySnapshot
} from './native-chat/input/native-chat-picker-items'
import {
  LEADING_SLASH_TRIGGER,
  MID_PROMPT_SLASH_TRIGGER,
  matchSkillSigil
} from './native-chat/input/native-chat-picker-triggers'

export type { SlashCommandSuggestion }
export { filterSlashCommands, isSlashCommandDraft, applySlashSuggestion, slashCommandDispatchText }
export {
  classifyNativeChatSend,
  type NativeChatSendClassification
} from './native-chat/input/native-chat-slash-commands'
export { applyPickerSuggestion } from './native-chat/input/native-chat-picker-triggers'
export {
  buildNativeChatPickerItems,
  type NativeChatPickerItem,
  type NativeChatSkillDiscoverySnapshot
} from './native-chat/input/native-chat-picker-items'

type PickerAutocomplete = {
  query: string
  items: NativeChatPickerItem[]
  triggerKey: string
  /** `$` lists only the skills of an agent whose skills carry that sigil. */
  prefix: '/' | '$'
  /** Only a draft-leading `/command` reaches the agent as a command. */
  dispatchable: boolean
  grouped: boolean
  commandsEnabled: boolean
  skillsEnabled: boolean
  skillStatus: NativeChatSkillDiscoverySnapshot['status']
  skillErrorKind?: NativeChatSkillDiscoverySnapshot['errorKind']
}

export type ComposerAutocomplete =
  | { mode: 'none' }
  | ({ mode: 'slash' } & PickerAutocomplete)
  | { mode: 'mention'; query: string; triggerKey: string }

const EMPTY_DISCOVERY: NativeChatSkillDiscoverySnapshot = { status: 'ready', skills: [] }

/** Whether the caret sits in a token that needs the skill catalog loaded. */
export function isSkillPickerTriggered(
  before: string,
  profile: NativeChatAgentProfile | null
): boolean {
  if (!profile) {
    return false
  }
  return (
    LEADING_SLASH_TRIGGER.test(before) ||
    MID_PROMPT_SLASH_TRIGGER.test(before) ||
    (profile.skillPrefix === '$' && matchSkillSigil(before) !== null)
  )
}

export function deriveComposerAutocomplete(
  draft: string,
  caret: number,
  agentCommands: readonly SlashCommandSuggestion[],
  skills: readonly DiscoveredSkill[] = [],
  profile: NativeChatAgentProfile | null = null,
  discovery: NativeChatSkillDiscoverySnapshot = { ...EMPTY_DISCOVERY, skills },
  dismissedTriggerKey: string | null = null,
  sessionSkills?: readonly NativeChatSessionSkill[],
  commandAvailable?: (name: string) => boolean
): ComposerAutocomplete {
  const before = draft.slice(0, caret)
  const leadingMatch = before.match(LEADING_SLASH_TRIGGER)
  if (leadingMatch) {
    return deriveSlashAutocomplete(
      '/',
      leadingMatch[1],
      0,
      agentCommands,
      profile,
      discovery,
      dismissedTriggerKey,
      sessionSkills,
      commandAvailable
    )
  }
  const mentionMatch = before.match(/(?:^|\s)@(\S*)$/)
  if (mentionMatch) {
    const triggerKey = `@:${before.length - mentionMatch[1].length - 1}`
    return dismissedTriggerKey === triggerKey
      ? { mode: 'none' }
      : { mode: 'mention', query: mentionMatch[1], triggerKey }
  }
  // Mid-prompt slash tokens use the command menu without dispatch; dollar tokens open the agent’s skills-only menu.
  const sigilQuery = profile?.skillPrefix === '$' ? matchSkillSigil(before) : null
  const query =
    sigilQuery ??
    (profile || (sessionSkills?.length ?? 0) > 0
      ? before.match(MID_PROMPT_SLASH_TRIGGER)?.[1]
      : undefined)
  if (query === undefined) {
    return { mode: 'none' }
  }
  const isSigil = sigilQuery !== null
  return deriveSlashAutocomplete(
    isSigil ? '$' : '/',
    query,
    before.length - query.length - 1,
    isSigil ? [] : agentCommands,
    profile,
    discovery,
    dismissedTriggerKey,
    sessionSkills,
    commandAvailable
  )
}

function deriveSlashAutocomplete(
  prefix: '/' | '$',
  query: string,
  triggerPosition: number,
  agentCommands: readonly SlashCommandSuggestion[],
  profile: NativeChatAgentProfile | null,
  discovery: NativeChatSkillDiscoverySnapshot,
  dismissedTriggerKey: string | null,
  sessionSkills: readonly NativeChatSessionSkill[] | undefined,
  commandAvailable?: (name: string) => boolean
): ComposerAutocomplete {
  const triggerKey = `${prefix}:${triggerPosition}`
  if (dismissedTriggerKey === triggerKey) {
    return { mode: 'none' }
  }
  // Native reports establish availability independently of optional disk scanning.
  const skillsEnabled = profile !== null || (sessionSkills?.length ?? 0) > 0
  const items = buildNativeChatPickerItems(
    agentCommands,
    nativeChatPickerScannedSkills(profile, discovery.skills),
    query,
    profile?.skillPrefix ?? '/',
    sessionSkills,
    undefined,
    prefix,
    commandAvailable
  )
  return {
    mode: 'slash',
    query,
    triggerKey,
    prefix,
    dispatchable: prefix === '/' && triggerPosition === 0,
    grouped: skillsEnabled && prefix === '/',
    commandsEnabled: agentCommands.length > 0,
    skillsEnabled,
    items,
    skillStatus:
      profile !== null && sessionSkills === undefined
        ? discovery.status === 'idle'
          ? 'loading'
          : discovery.status
        : 'ready',
    ...(profile !== null && sessionSkills === undefined && discovery.errorKind
      ? { skillErrorKind: discovery.errorKind }
      : {})
  }
}

/** Scanned names take the agent's prefix so they match the names its session reports. */
export function nativeChatPickerScannedSkills(
  profile: NativeChatAgentProfile | null,
  skills: readonly DiscoveredSkill[]
): readonly DiscoveredSkill[] {
  if (!profile) {
    return []
  }
  const namePrefix = profile.skillNamePrefix
  return namePrefix
    ? skills.map((skill) => ({ ...skill, name: `${namePrefix}${skill.name}` }))
    : skills
}

/** Replacing across an entire dismissed token starts a new occurrence; typing/deleting within it does not. */
export function editReplacesTriggerToken(
  previous: string,
  next: string,
  triggerKey: string
): boolean {
  const triggerPosition = Number.parseInt(triggerKey.slice(triggerKey.indexOf(':') + 1), 10)
  if (!Number.isFinite(triggerPosition) || previous === next) {
    return false
  }
  let commonPrefix = 0
  const maxPrefix = Math.min(previous.length, next.length)
  while (commonPrefix < maxPrefix && previous[commonPrefix] === next[commonPrefix]) {
    commonPrefix += 1
  }
  let commonSuffix = 0
  while (
    commonSuffix < previous.length - commonPrefix &&
    commonSuffix < next.length - commonPrefix &&
    previous[previous.length - 1 - commonSuffix] === next[next.length - 1 - commonSuffix]
  ) {
    commonSuffix += 1
  }
  const removed = previous.length - commonPrefix - commonSuffix
  const inserted = next.length - commonPrefix - commonSuffix
  if (removed === 0 || inserted === 0) {
    return false
  }
  let tokenEnd = triggerPosition + 1
  while (tokenEnd < previous.length && !/\s/.test(previous[tokenEnd])) {
    tokenEnd += 1
  }
  return commonPrefix < tokenEnd && previous.length - commonSuffix > triggerPosition
}

export function applyMentionSuggestion(
  draft: string,
  caret: number,
  path: string
): { draft: string; caret: number } {
  const before = draft.slice(0, caret)
  const after = draft.slice(caret)
  const match = before.match(/(^|\s)@(\S*)$/)
  if (!match) {
    return { draft, caret }
  }
  const tokenStart = before.length - match[2].length - 1
  const nextBefore = `${before.slice(0, tokenStart)}${formatNativeChatFileReference(path)} `
  return { draft: nextBefore + after.replace(/^ /, ''), caret: nextBefore.length }
}
