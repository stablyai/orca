// Binary Allow/Deny keystrokes for an agent permission prompt.
// The phone registers them as a notification category; Apple Watch shows those actions.
import {
  nativeChatApprovalAcceptKey,
  resolveNativeChatTranscriptAgent
} from '../native-chat/native-chat-agent-support'

export const WATCH_PROMPT_CATEGORY = 'orca.prompt-decision'
export const WATCH_PROMPT_ALLOW_ACTION = 'allow'
export const WATCH_PROMPT_DENY_ACTION = 'deny'
export const WATCH_PROMPT_REPLY_MAX_LENGTH = 8

export type WatchPromptAction = typeof WATCH_PROMPT_ALLOW_ACTION | typeof WATCH_PROMPT_DENY_ACTION

export type WatchPromptReply = {
  readonly allow: string
  readonly deny: string
}

const ESCAPE = String.fromCharCode(27)
const PAUSED_STATES: ReadonlySet<string> = new Set(['blocked', 'waiting', 'needs-input'])
const NUMBERED_OPTION_RE = /(?:^|\n)\s*(\d+)[.)]\s*([^\n]+)/g
const EXPLICIT_YES_NO_RE = /\(y\/n\)|\by\/n\b|\byes\/no\b/i
const ALWAYS_RE = /\balways\b|don't ask again|do not ask again|for the rest|this session/i
const DENY_RE = /\b(?:no|deny|reject|decline|cancel)\b/i
const ALLOW_RE = /\b(?:yes|allow|approve|accept|proceed|grant)\b/i

type NumberedOption = { num: string; text: string }
type OptionKind = 'allow' | 'allow-always' | 'deny' | 'other'

export function isWatchPromptAction(action: string): action is WatchPromptAction {
  return action === WATCH_PROMPT_ALLOW_ACTION || action === WATCH_PROMPT_DENY_ACTION
}

export function watchPromptReplyFromAgent(input: {
  state?: string | null
  agent?: string | null
  interactivePrompt?: string | null
  lastAssistantMessage?: string | null
}): WatchPromptReply | null {
  if (!input.state || !PAUSED_STATES.has(input.state)) {
    return null
  }
  // OpenCode's card is the envelope only; a guessed y/n would not match its Enter/Escape keys.
  if (resolveNativeChatTranscriptAgent(input.agent) !== 'opencode') {
    const fromText = replyFromText(input.lastAssistantMessage)
    if (fromText) {
      return fromText
    }
  }
  return replyFromEnvelope(input.interactivePrompt, input.agent)
}

function replyFromText(text: string | null | undefined): WatchPromptReply | null {
  if (!text?.trim()) {
    return null
  }
  const numbered = parseNumberedOptions(text)
  if (numbered.length >= 2) {
    return replyFromNumbered(numbered)
  }
  if (!EXPLICIT_YES_NO_RE.test(text)) {
    return null
  }
  return fitReply({ allow: 'y', deny: 'n' })
}

function replyFromEnvelope(
  interactivePrompt: string | null | undefined,
  agent: string | null | undefined
): WatchPromptReply | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  if (!('approval' in parsed) || !isApproval(parsed.approval)) {
    return null
  }
  const tool = parsed.approval.tool
  if (typeof tool !== 'string' || tool.length === 0) {
    return null
  }
  return fitReply({ allow: nativeChatApprovalAcceptKey(agent), deny: ESCAPE })
}

function isApproval(value: unknown): value is { tool?: unknown } {
  return value !== null && typeof value === 'object'
}

function parseNumberedOptions(text: string): NumberedOption[] {
  const out: NumberedOption[] = []
  for (const match of text.matchAll(NUMBERED_OPTION_RE)) {
    const num = match[1]
    const body = match[2]?.trim()
    if (num && body) {
      out.push({ num, text: body })
    }
  }
  return out
}

function replyFromNumbered(options: readonly NumberedOption[]): WatchPromptReply | null {
  let allow: string | undefined
  let allowAlways: string | undefined
  let deny: string | undefined
  for (const option of options) {
    const kind = classifyOption(option.text)
    if (kind === 'allow') {
      if (allow !== undefined) {
        return null
      }
      allow = option.num
    } else if (kind === 'allow-always') {
      if (allowAlways !== undefined) {
        return null
      }
      allowAlways = option.num
    } else if (kind === 'deny') {
      if (deny !== undefined) {
        return null
      }
      deny = option.num
    }
  }
  const chosenAllow = allow ?? allowAlways
  if (!chosenAllow || !deny) {
    return null
  }
  return fitReply({ allow: chosenAllow, deny })
}

function classifyOption(text: string): OptionKind {
  const allow = ALLOW_RE.test(text)
  const deny = DENY_RE.test(text)
  if (ALWAYS_RE.test(text) && allow && !deny) {
    return 'allow-always'
  }
  if (deny && !allow) {
    return 'deny'
  }
  if (allow && !deny) {
    return 'allow'
  }
  return 'other'
}

function fitReply(reply: WatchPromptReply): WatchPromptReply | null {
  if (
    reply.allow.length === 0 ||
    reply.deny.length === 0 ||
    reply.allow.length > WATCH_PROMPT_REPLY_MAX_LENGTH ||
    reply.deny.length > WATCH_PROMPT_REPLY_MAX_LENGTH
  ) {
    return null
  }
  return reply
}
