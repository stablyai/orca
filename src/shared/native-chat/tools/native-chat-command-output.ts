// Claude-family local-command-stdout user turns link to command envelopes. Hide effect-only feedback (/model, /compact);
// surface reporting-command replies as their answer.

import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import { stripAnsiEscapeSequences } from '../../ansi-escape-sequences'
import { getVerifiedNativeChatCommands } from '../native-chat-agent-profiles'
import { parseNativeChatCommandEnvelope } from '../native-chat-command-envelope'
import { isTextBlock, type NativeChatMessage } from '../native-chat-types'

const LOCAL_COMMAND_STDOUT = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/

const commandNames = new WeakMap<NativeChatMessage, string | null>()

const userTexts = new WeakMap<NativeChatMessage['blocks'], string | null>()

function userText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  if (userTexts.has(message.blocks)) {
    return userTexts.get(message.blocks)!
  }
  const text = message.blocks.every(isTextBlock)
    ? message.blocks.map((block) => block.text).join('\n')
    : null
  userTexts.set(message.blocks, text)
  return text
}

/** The command a user turn's envelope names, without its slash; null for other turns. */
export function nativeChatCommandName(message: NativeChatMessage): string | null {
  if (commandNames.has(message)) {
    return commandNames.get(message)!
  }
  const text = userText(message)
  const envelope = text === null ? null : parseNativeChatCommandEnvelope(text)
  const name = envelope ? envelope.name.replace(/^\//, '') : null
  commandNames.set(message, name)
  return name
}

export function nativeChatCommandOutputParentId(message: NativeChatMessage): string | null {
  return message.parentId !== undefined && LOCAL_COMMAND_STDOUT.test(userText(message) ?? '')
    ? message.parentId
    : null
}

/** Surface catalog-declared transcript replies as command output, matched by explicit row link. Older unlinked replies or unloaded command rows stay hidden. */
export function surfaceNativeChatCommandOutputs(
  messages: NativeChatMessage[],
  agent: AgentType
): NativeChatMessage[] {
  const transcriptReplies = new Set(
    getVerifiedNativeChatCommands(agent)
      .filter((command) => command.reply === 'transcript')
      .map((command) => command.name)
  )
  // Why: this runs on every transcript update; agents declaring no such reply skip the scan.
  if (transcriptReplies.size === 0) {
    return messages
  }
  let rowsById: Map<string, NativeChatMessage> | null = null
  let changed = false
  const out = messages.map((message) => {
    if (message.parentId === undefined) {
      return message
    }
    const stdout = LOCAL_COMMAND_STDOUT.exec(userText(message) ?? '')?.[1]
    if (stdout === undefined) {
      return message
    }
    rowsById ??= new Map(messages.map((row) => [row.id, row]))
    const parent = rowsById.get(message.parentId)
    const command = parent ? nativeChatCommandName(parent) : null
    if (command === null || !transcriptReplies.has(command)) {
      return message
    }
    const text = stripAnsiEscapeSequences(stdout).trim()
    if (!text) {
      return message
    }
    changed = true
    return {
      ...message,
      role: 'system' as const,
      blocks: [{ type: 'text' as const, text, presentation: 'command-output' }]
    }
  })
  return changed ? out : messages
}
