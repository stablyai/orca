// `/side` and its alias `/btw` in structured chats.

import type { SlashCommandSuggestion } from './native-chat-slash-commands'

export const NATIVE_CHAT_SIDE_CHAT_COMMANDS = ['side', 'btw'] as const

export function isNativeChatSideChatCommand(
  name: string | null
): name is (typeof NATIVE_CHAT_SIDE_CHAT_COMMANDS)[number] {
  return NATIVE_CHAT_SIDE_CHAT_COMMANDS.some((command) => command === name)
}

/** `/side [question]` or `/btw [question]` as the whole message; null for anything else. */
export function parseNativeChatSideChatDraft(
  draft: string
): { name: string; question: string } | null {
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/i.exec(draft.trim())
  const name = match?.[1]?.toLowerCase()
  return name ? { name, question: match?.[2]?.trim() ?? '' } : null
}

export function nativeChatProviderOwnsSideCommand(
  commands: readonly { name: string; kind: string }[] | undefined,
  name: string
): boolean {
  return commands?.some((command) => command.kind === 'command' && command.name === name) ?? false
}

/** Auxiliary chats defer to reported provider commands with the same name. */
export function withNativeChatSideChatCommands(
  commands: readonly SlashCommandSuggestion[],
  copy: { side: string; btw: string; argumentHint: string; unavailableReason: string | null },
  providerOwns?: (name: string) => boolean
): SlashCommandSuggestion[] {
  const rows = NATIVE_CHAT_SIDE_CHAT_COMMANDS.filter((name) => !providerOwns?.(name)).map(
    (name): SlashCommandSuggestion => ({
      name,
      description: copy.unavailableReason ?? copy[name],
      argumentHint: copy.argumentHint,
      orcaOwned: true
    })
  )
  return [...rows, ...commands.filter(({ name }) => !rows.some((row) => row.name === name))]
}
