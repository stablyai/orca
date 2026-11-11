import { z } from 'zod'
import { OptionsParams } from './structured-agent-session-params'

export const AGENT_SESSION_SHELL_COMMAND_TIMEOUT_MS = 120_000
export const AGENT_SESSION_SHELL_COMMAND_MAX_OUTPUT_BYTES = 256 * 1024

export const ShellCommandParams = OptionsParams.extend({
  command: z.string().trim().min(1).max(8192)
}).strict()

export type AgentSessionShellOutputChunk = {
  stream: 'stdout' | 'stderr'
  text: string
}

export type AgentSessionShellCommandExit = {
  exitCode: number | null
  timedOut: boolean
  outputTruncated: boolean
  output?: AgentSessionShellOutputChunk[]
  error?: string
}

export type AgentSessionShellCommandFrame =
  | { type: 'started'; directory: string | null }
  | { type: 'output'; chunks: AgentSessionShellOutputChunk[] }
  | ({ type: 'exit' } & AgentSessionShellCommandExit)
