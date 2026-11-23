import type { NativeChatAgent } from '../agent-launch/permissions/agent-chat-permission-support'

/** Native-chat agents a bot cannot run on yet; each waits on a live check of its preamble delivery. */
export const BOT_HELD_BACK_AGENTS = [] as const

/** Bots run in a native chat; every native-chat agent but the held-back ones. */
export const BOT_AGENTS = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity',
  'cursor',
  'hermes',
  'copilot',
  'opencode2',
  'kimi',
  'kiro',
  'aug',
  'goose',
  'kilo',
  'mimo-code',
  'gemini',
  'droid',
  'qwen-code',
  'cline',
  'devin',
  'codebuddy'
] as const satisfies readonly Exclude<NativeChatAgent, (typeof BOT_HELD_BACK_AGENTS)[number]>[]

export type BotAgent = (typeof BOT_AGENTS)[number]

export function isBotAgent(agent: string): agent is BotAgent {
  return BOT_AGENTS.some((entry) => entry === agent)
}
