import type { DiscoveredSkill } from '../../../../shared/skills'
import type { NativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import {
  filterSlashCommands,
  isSlashCommandDraft,
  applySlashSuggestion,
  slashCommandDispatchText,
  type SlashCommandSuggestion
} from '../../../../shared/native-chat-slash-commands'
import {
  buildNativeChatPickerItems,
  LEADING_SLASH_TRIGGER,
  MID_PROMPT_SLASH_TRIGGER,
  type NativeChatPickerItem,
  type NativeChatSkillDiscoverySnapshot
} from './native-chat-picker-items'

export type { SlashCommandSuggestion }
export { filterSlashCommands, isSlashCommandDraft, applySlashSuggestion, slashCommandDispatchText }
export {
  applyPickerSuggestion,
  buildNativeChatPickerItems,
  classifyNativeChatSend,
  type NativeChatPickerItem,
  type NativeChatSendClassification,
  type NativeChatSkillDiscoverySnapshot
} from './native-chat-picker-items'

type PickerAutocomplete = {
  query: string
  items: NativeChatPickerItem[]
  triggerKey: string
  prefix: '/'
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
  | { mode: 'mention'; query: string }

const EMPTY_DISCOVERY: NativeChatSkillDiscoverySnapshot = { status: 'ready', skills: [] }

/** Whether the caret sits in a token that needs the skill catalog loaded. */
export function isSkillPickerTriggered(
  before: string,
  profile: NativeChatAgentProfile | null
): boolean {
  if (!profile) {
    return false
  }
  return LEADING_SLASH_TRIGGER.test(before) || MID_PROMPT_SLASH_TRIGGER.test(before)
}

export function deriveComposerAutocomplete(
  draft: string,
  caret: number,
  agentCommands: readonly SlashCommandSuggestion[],
  skills: readonly DiscoveredSkill[] = [],
  profile: NativeChatAgentProfile | null = null,
  discovery: NativeChatSkillDiscoverySnapshot = { ...EMPTY_DISCOVERY, skills },
  dismissedTriggerKey: string | null = null,
  sessionSkillNames?: readonly string[]
): ComposerAutocomplete {
  const before = draft.slice(0, caret)
  const leadingMatch = before.match(LEADING_SLASH_TRIGGER)
  if (leadingMatch) {
    return deriveSlashAutocomplete(
      leadingMatch[1],
      0,
      agentCommands,
      profile,
      discovery,
      dismissedTriggerKey,
      sessionSkillNames
    )
  }
  const mentionMatch = before.match(/(?:^|\s)@(\S*)$/)
  if (mentionMatch) {
    return { mode: 'mention', query: mentionMatch[1] }
  }
  // Why: `/` is the whole composer grammar, so a mid-prompt token opens the same
  // menu a leading one does — it just cannot dispatch.
  const midPromptMatch = profile ? before.match(MID_PROMPT_SLASH_TRIGGER) : null
  if (!midPromptMatch) {
    return { mode: 'none' }
  }
  const query = midPromptMatch[1]
  return deriveSlashAutocomplete(
    query,
    before.length - query.length - 1,
    agentCommands,
    profile,
    discovery,
    dismissedTriggerKey,
    sessionSkillNames
  )
}

function deriveSlashAutocomplete(
  query: string,
  triggerPosition: number,
  agentCommands: readonly SlashCommandSuggestion[],
  profile: NativeChatAgentProfile | null,
  discovery: NativeChatSkillDiscoverySnapshot,
  dismissedTriggerKey: string | null,
  sessionSkillNames: readonly string[] | undefined
): ComposerAutocomplete {
  const triggerKey = `/:${triggerPosition}`
  if (dismissedTriggerKey === triggerKey) {
    return { mode: 'none' }
  }
  // Every agent with a known grammar offers skills here; only the token a pick
  // inserts differs. The caller owns catalog policy (e.g. Grok ships skills-only
  // until a verified catalog lands), so this derivation must not re-gate per agent.
  const skillsEnabled = profile !== null
  const items = buildNativeChatPickerItems(
    agentCommands,
    skillsEnabled ? discovery.skills : [],
    query,
    profile?.skillPrefix ?? '/',
    skillsEnabled ? sessionSkillNames : []
  )
  return {
    mode: 'slash',
    query,
    triggerKey,
    prefix: '/',
    dispatchable: triggerPosition === 0,
    grouped: skillsEnabled,
    commandsEnabled: agentCommands.length > 0,
    skillsEnabled,
    items,
    skillStatus: skillsEnabled
      ? discovery.status === 'idle'
        ? 'loading'
        : discovery.status
      : 'ready',
    ...(skillsEnabled && discovery.errorKind ? { skillErrorKind: discovery.errorKind } : {})
  }
}

/** True when one edit both removed and inserted text across the dismissed
 *  trigger token — a wholesale replacement (e.g. select-all + paste), which is
 *  a new trigger occurrence even though a trigger character lands back on the
 *  same draft position. Typing or deleting inside the token is not. */
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
  const nextBefore = `${before.slice(0, tokenStart)}@${path} `
  return { draft: nextBefore + after, caret: nextBefore.length }
}

export type HistoryState = { entries: readonly string[]; index: number | null }
export const EMPTY_HISTORY: HistoryState = { entries: [], index: null }

export function pushHistory(history: HistoryState, sent: string): HistoryState {
  if (sent.trim() === '' || history.entries.at(-1) === sent) {
    return { entries: history.entries, index: null }
  }
  return { entries: [...history.entries, sent], index: null }
}

export type HistoryRecall = { history: HistoryState; draft: string | null }

export function recallPrevious(history: HistoryState): HistoryRecall {
  if (history.entries.length === 0) {
    return { history, draft: null }
  }
  const index = history.index === null ? history.entries.length - 1 : Math.max(0, history.index - 1)
  return { history: { entries: history.entries, index }, draft: history.entries[index] }
}

export function recallNext(history: HistoryState): HistoryRecall {
  if (history.index === null) {
    return { history, draft: null }
  }
  const index = history.index + 1
  if (index >= history.entries.length) {
    return { history: { entries: history.entries, index: null }, draft: '' }
  }
  return { history: { entries: history.entries, index }, draft: history.entries[index] }
}
