import {
  AGENT_SESSION_SHELL_COMMAND_TIMEOUT_MS,
  type AgentSessionShellOutputChunk
} from '../../rpc-contract/structured-agent-session-shell-command-params'
import { clampUtf8TextTail } from '../../utf8-byte-limits'

type NativeChatShellBlockInput = {
  output: string
  exitCode: number | null
  timedOut: boolean
  outputTruncated: boolean
  stopped?: boolean
  directory: string | null
}

const NATIVE_CHAT_SHELL_CONTEXT_BYTES = 64 * 1024

function utf8Tail(text: string, maxBytes: number): { text: string; cut: boolean } {
  const tail = clampUtf8TextTail(text, maxBytes).text
  if (tail.length === text.length) {
    return { text, cut: false }
  }
  const lineStart = tail.indexOf('\n')
  return { text: lineStart === -1 ? tail : tail.slice(lineStart + 1), cut: true }
}

export function appendNativeChatShellOutput(
  output: readonly AgentSessionShellOutputChunk[],
  chunk: AgentSessionShellOutputChunk
): AgentSessionShellOutputChunk[] {
  const last = output.at(-1)
  return last?.stream === chunk.stream
    ? [...output.slice(0, -1), { stream: chunk.stream, text: last.text + chunk.text }]
    : [...output, chunk]
}

export function isNativeChatShellDraft(draft: string): boolean {
  return draft.startsWith('!')
}

export function nativeChatShellCommand(draft: string): string | null {
  if (!isNativeChatShellDraft(draft)) {
    return null
  }
  const command = draft.slice(1).trim()
  return command === '' ? null : command
}

export function nativeChatShellCommandBlock(
  command: string,
  result: NativeChatShellBlockInput
): string {
  const status = result.stopped
    ? '[stopped]'
    : result.timedOut
      ? `[timed out after ${AGENT_SESSION_SHELL_COMMAND_TIMEOUT_MS / 1000}s]`
      : result.exitCode !== 0
        ? `[exit ${result.exitCode ?? 'killed'}]`
        : ''
  const output = utf8Tail(result.output.trimEnd(), NATIVE_CHAT_SHELL_CONTEXT_BYTES)
  const truncated =
    output.cut || result.outputTruncated
      ? `[output truncated to the last ${NATIVE_CHAT_SHELL_CONTEXT_BYTES / 1024} KB]`
      : ''
  const directory = result.directory ? `[in ${result.directory}]` : ''
  const body = [`$ ${command}`, directory, truncated, output.text, status]
    .filter((part) => part !== '')
    .join('\n')
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}console\n${body}\n${fence}`
}

export function nativeChatShellBlocksWithoutFences(text: string): string {
  return text.replace(/^(`{3,})console\n([\s\S]*?)\n\1$/gm, '$2')
}
