// Claude-family harnesses record a local command's reply as a
// `<local-command-stdout>` user turn linked to the command's envelope row. The
// noise filter hides those rows, which is right for commands whose effect is the
// feedback (`/model`, `/compact`). For a command that exists to report
// something, the reply is the answer, so the chat surfaces it.

import type { AgentType } from './agent-status-types'
import { stripAnsiEscapeSequences } from './ansi-escape-sequences'
import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'
import { parseNativeChatCommandEnvelope } from './native-chat-command-envelope'
import { isTextBlock, type NativeChatMessage } from './native-chat-types'

const LOCAL_COMMAND_STDOUT = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/

function userText(message: NativeChatMessage): string | null {
  return message.role === 'user' && message.blocks.every(isTextBlock)
    ? message.blocks.map((block) => block.text).join('\n')
    : null
}

/** The command a user turn's envelope names, without its slash; null for other turns. */
function envelopeCommand(message: NativeChatMessage): string | null {
  const text = userText(message)
  const envelope = text === null ? null : parseNativeChatCommandEnvelope(text)
  return envelope ? envelope.name.replace(/^\//, '') : null
}

/**
 * Replace the stdout row answering a command whose catalog row declares a
 * transcript reply with its plain text as command output. A reply answers the
 * row it is linked to; without that link (an older host, or the command row
 * outside the loaded window) it stays hidden.
 */
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
    const command = parent ? envelopeCommand(parent) : null
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
