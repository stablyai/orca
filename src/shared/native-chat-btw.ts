import { getCommitMessageAgentSpec, getCommitMessageModel } from './commit-message-agent-spec'
import type { NativeChatMessage } from './native-chat-types'
import type { SlashCommandSuggestion } from './native-chat-slash-commands'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

const SIDE_QUESTION_AGENT_ALIASES: Record<string, TuiAgent> = {
  openclaude: 'claude',
  'claude-agent-teams': 'claude',
  opencode2: 'opencode'
}

/** The non-interactive agent that answers a Chat UI `/btw`, or null when none is wired. */
export function nativeChatSideQuestionAgentId(agent: string): TuiAgent | null {
  const mapped = SIDE_QUESTION_AGENT_ALIASES[agent] ?? agent
  if (!isTuiAgent(mapped) || !getCommitMessageAgentSpec(mapped)) {
    return null
  }
  return mapped
}

/** Session model if the one-shot spec accepts it; otherwise that spec's default. */
export function nativeChatSideQuestionModelId(
  agentId: TuiAgent,
  requested?: string
): string | null {
  const spec = getCommitMessageAgentSpec(agentId)
  if (!spec) {
    return null
  }
  const model = requested?.trim()
  if (model && getCommitMessageModel(agentId, model)) {
    return model
  }
  return spec.defaultModelId
}

/** OpenCode `build` can edit files; `/btw` must run the plan agent instead. */
export function nativeChatSideQuestionReadOnlyArgs(
  agentId: TuiAgent,
  args: readonly string[]
): string[] {
  if (agentId !== 'opencode' && agentId !== 'opencode2') {
    return [...args]
  }
  const next = [...args]
  const index = next.indexOf('--agent')
  if (index !== -1 && next[index + 1]) {
    next[index + 1] = 'plan'
  }
  return next
}

/** Host-owned Chat UI command: a side question that never joins the transcript. */
export const NATIVE_CHAT_BTW_COMMAND: SlashCommandSuggestion = {
  name: 'btw',
  description: 'Ask a side question without adding it to the conversation',
  argumentHint: '<question>'
}

const BTW_COMMAND = /^\/btw(?:\s+(.*))?$/iu
const TRANSCRIPT_EXCERPT_MAX_CHARS = 24_000

/** `/btw` or `/btw …`. The argument may be empty: the overlay then takes the question. */
export function parseNativeChatBtwCommand(text: string): { question: string } | null {
  const match = BTW_COMMAND.exec(text.trim())
  return match ? { question: match[1]?.trim() ?? '' } : null
}

export function isNativeChatBtwCommand(text: string): boolean {
  return parseNativeChatBtwCommand(text) !== null
}

/** Prepend the host `/btw` row when the catalog does not already name it. */
export function withNativeChatBtwCommand(
  commands: readonly SlashCommandSuggestion[]
): SlashCommandSuggestion[] {
  if (commands.some((command) => command.name === 'btw')) {
    return [...commands]
  }
  return [NATIVE_CHAT_BTW_COMMAND, ...commands]
}

/** User and assistant prose only. Tool I/O stays out so the side question cannot
 *  treat a command payload as instructions. */
export function nativeChatBtwTranscriptExcerpt(messages: readonly NativeChatMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) {
      continue
    }
    parts.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  const joined = parts.join('\n\n')
  if (joined.length <= TRANSCRIPT_EXCERPT_MAX_CHARS) {
    return joined
  }
  return joined.slice(joined.length - TRANSCRIPT_EXCERPT_MAX_CHARS)
}

export function buildNativeChatBtwPrompt(
  messages: readonly NativeChatMessage[],
  question: string
): string {
  const excerpt = nativeChatBtwTranscriptExcerpt(messages)
  const conversation = excerpt || '(The session has no user or assistant messages yet.)'
  return [
    'You are answering a side question about an ongoing coding session.',
    'You have no tools. Answer only from the conversation excerpt.',
    'Be concise. Do not propose file edits or run commands.',
    '',
    'Conversation:',
    conversation,
    '',
    'Side question:',
    question.trim()
  ].join('\n')
}
