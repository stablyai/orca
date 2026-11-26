// `/side` and its alias `/btw`: ask a side question in a fork beside the chat, shared by desktop and phone.

import type { SlashCommandSuggestion } from './native-chat-slash-commands'

export const NATIVE_CHAT_SIDE_CHAT_COMMANDS = ['side', 'btw'] as const

export function isNativeChatSideChatCommand(
  name: string | null
): name is (typeof NATIVE_CHAT_SIDE_CHAT_COMMANDS)[number] {
  return NATIVE_CHAT_SIDE_CHAT_COMMANDS.some((command) => command === name)
}

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
  // Ahead of the agent's own, as Orca's built-ins are, so a long catalog never pushes them out.
  return [...rows, ...commands.filter(({ name }) => !isNativeChatSideChatCommand(name))]
}
