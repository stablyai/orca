// `/side` and its alias `/btw`: ask a side question in a fork beside the chat, shared by desktop and phone.

import type { SlashCommandSuggestion } from './native-chat-slash-commands'

export const NATIVE_CHAT_SIDE_CHAT_COMMANDS = ['side', 'btw'] as const

/** `/side [question]` or `/btw [question]` as the whole message; null for anything else. */
export function parseNativeChatSideChatDraft(draft: string): { question: string } | null {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(draft.trim())
  return match ? { question: match[1]?.trim() ?? '' } : null
}

/** Orca's rows replace the agent's own `side` and `btw`; while unavailable they say why. */
export function withNativeChatSideChatCommands(
  commands: readonly SlashCommandSuggestion[],
  copy: { side: string; btw: string; argumentHint: string; unavailableReason: string | null }
): SlashCommandSuggestion[] {
  const rows = NATIVE_CHAT_SIDE_CHAT_COMMANDS.map((name): SlashCommandSuggestion => ({
    name,
    description: copy.unavailableReason ?? copy[name],
    argumentHint: copy.argumentHint,
    orcaOwned: true
  }))
  return [
    ...commands.filter(
      ({ name }) => !(NATIVE_CHAT_SIDE_CHAT_COMMANDS as readonly string[]).includes(name)
    ),
    ...rows
  ]
}
