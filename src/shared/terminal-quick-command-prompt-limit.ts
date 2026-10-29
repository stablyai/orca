import { getTerminalInputByteLength } from './terminal-input'
import { structuredAgentSessionBlocksByteLength } from './rpc-contract/structured-agent-session-message-params'
import { TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY } from './terminal-quick-command-capabilities'
import type {
  TerminalQuickCommand,
  TerminalQuickCommandAction
} from './terminal-quick-command-types'
import {
  isTerminalAgentQuickCommand,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
} from './terminal-quick-commands'

// Every prompt must fit the tightest path: a chat text block’s 256 KiB JSON budget, measured after escaping. Paired create/save limits are looser; tests pin this to chat.
export const MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES = 256 * 1024
// Older builds reject long saves and entire lists containing them; use only for legacy peers.
export const LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH = 6000
// Why: the whole list is one RPC reply, which a paired session closes over past 4 MiB of JSON;
// this leaves room for the reply envelope and echoed request id.
export const MAX_TERMINAL_QUICK_COMMANDS_SERIALIZED_BYTES = 4 * 1024 * 1024 - 128 * 1024

/** Unknown capabilities must not block saves: older hosts visibly reject oversized prompts themselves. Null means long prompts are supported. */
export function terminalQuickCommandAgentPromptMaxLength(
  hostCapabilities: readonly string[] | null | undefined
): number | null {
  return hostCapabilities &&
    !hostCapabilities.includes(TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY)
    ? LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH
    : null
}

export function getTerminalQuickCommandBodyMaxLength(
  action: TerminalQuickCommandAction,
  agentPromptMaxLength: number | null
): number | null {
  return action === 'agent-prompt' ? agentPromptMaxLength : MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
}

export function getTerminalQuickCommandPromptMessageBytes(prompt: string): number {
  return structuredAgentSessionBlocksByteLength([{ type: 'text', text: prompt }])
}

export type TerminalQuickCommandBodySize = {
  used: number
  max: number
  unit: 'characters' | 'bytes'
  /** An older host's 6,000-character cap is what refuses it. */
  olderHostCap: boolean
}

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

/** Bound storage by prompt size and one paired-client reply; normalization deliberately never trims prompts. */
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
