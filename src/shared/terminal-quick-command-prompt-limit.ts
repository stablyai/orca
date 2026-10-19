import { getTerminalInputByteLength } from './terminal-input'
import { TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY } from './terminal-quick-command-capabilities'
import type {
  TerminalQuickCommand,
  TerminalQuickCommandAction
} from './terminal-quick-command-types'
import {
  isTerminalAgentQuickCommand,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
} from './terminal-quick-commands'

// Why: a saved prompt must run on every path, and the tightest is a chat message, whose blocks may
// be at most 256 KiB of JSON. Measured on the prompt's real escaped size, not a per-character worst
// case; a paired create's 256 KiB of UTF-8 and one save's inbound frame are looser. Pinned against
// the chat limit in tests. Part of `terminal.quick-commands.long-prompts.v1`.
export const MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES = 256 * 1024
// Why: builds before long-prompt support refuse longer prompts on save and reject a whole list
// holding one; this is only for talking to those builds.
export const LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH = 6000
// Why: the whole list is one RPC reply, which a paired session closes over past 4 MiB of JSON;
// this leaves room for the reply envelope and echoed request id.
export const MAX_TERMINAL_QUICK_COMMANDS_SERIALIZED_BYTES = 4 * 1024 * 1024 - 128 * 1024

/**
 * The character cap of an older host, or `null` for a host that takes long prompts. Unknown
 * capabilities count as current: an older host refuses a longer prompt itself, visibly, so
 * guessing must never block a save.
 */
export function terminalQuickCommandAgentPromptMaxLength(
  hostCapabilities: readonly string[] | null | undefined
): number | null {
  return hostCapabilities &&
    !hostCapabilities.includes(TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY)
    ? LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH
    : null
}

/** A character cap, or `null` when only the message-size bound applies. */
export function getTerminalQuickCommandBodyMaxLength(
  action: TerminalQuickCommandAction,
  agentPromptMaxLength: number | null
): number | null {
  return action === 'agent-prompt' ? agentPromptMaxLength : MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
}

/** The prompt's size as a chat message's text block, the limit every saved prompt must fit. */
export function getTerminalQuickCommandPromptMessageBytes(prompt: string): number {
  return getTerminalInputByteLength(JSON.stringify([{ type: 'text', text: prompt }]))
}

export type TerminalQuickCommandBodySize = {
  used: number
  max: number
  unit: 'characters' | 'bytes'
  /** An older host's 6,000-character cap is what refuses it. */
  olderHostCap: boolean
}

/** How much of its limit a quick command's body uses, in the unit that limit is measured in. */
export function getTerminalQuickCommandBodySize(
  action: TerminalQuickCommandAction,
  body: string,
  agentPromptMaxLength: number | null
): TerminalQuickCommandBodySize {
  const text = body.trimEnd()
  const maxLength = getTerminalQuickCommandBodyMaxLength(action, agentPromptMaxLength)
  if (maxLength !== null) {
    return {
      used: text.length,
      max: maxLength,
      unit: 'characters',
      olderHostCap: action === 'agent-prompt'
    }
  }
  return {
    used: getTerminalQuickCommandPromptMessageBytes(text),
    max: MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES,
    unit: 'bytes',
    olderHostCap: false
  }
}

export function isTerminalQuickCommandPromptTooLong(
  prompt: string,
  agentPromptMaxLength: number | null
): boolean {
  return agentPromptMaxLength === null
    ? getTerminalQuickCommandPromptMessageBytes(prompt) >
        MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES
    : prompt.length > agentPromptMaxLength
}

/**
 * Refuses a list the host must not store: a prompt over the cap, or a list too large to send to a
 * paired client in one reply. Normalization never trims a prompt, so this is the bound.
 */
export function assertTerminalQuickCommandsStorable(
  commands: readonly TerminalQuickCommand[]
): void {
  for (const command of commands) {
    if (
      isTerminalAgentQuickCommand(command) &&
      isTerminalQuickCommandPromptTooLong(command.prompt, null)
    ) {
      throw new Error(
        `The prompt for "${command.label}" is ${formatKilobytes(getTerminalQuickCommandPromptMessageBytes(command.prompt))}. Quick command prompts can be up to ${formatKilobytes(MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES)}.`
      )
    }
  }
  const bytes = getTerminalInputByteLength(JSON.stringify(commands))
  if (bytes > MAX_TERMINAL_QUICK_COMMANDS_SERIALIZED_BYTES) {
    throw new Error(
      `Quick commands total ${formatMegabytes(bytes)}, over the ${formatMegabytes(MAX_TERMINAL_QUICK_COMMANDS_SERIALIZED_BYTES)} limit. Shorten or remove a prompt.`
    )
  }
}

export function formatKilobytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024).toLocaleString('en-US')} KB`
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function isLegacyReadableTerminalQuickCommand(command: TerminalQuickCommand): boolean {
  return (
    !isTerminalAgentQuickCommand(command) ||
    command.prompt.length <= LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH
  )
}
