import {
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from './agent-process-recognition'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'
import type { AgentType } from './agent-status-types'

export const AGENT_IDENTITY_ALIASES_LOWER: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude code'],
  gemini: ['gemini cli'],
  antigravity: ['agy']
}

const COMMAND_LINE_FLAG_RE = /^(?:--[\w-]+|-[A-Za-z0-9]+)(?:\s|=|$)/

export function recognizeAgentCommandLine(
  title: string | null | undefined,
  agentType?: AgentType | null | undefined
): RecognizedAgentProcess | null {
  if (!title) {
    return null
  }
  const trimmed = title.trim()
  if (!trimmed) {
    return null
  }
  const tokens = tokenizeCommandLine(trimmed)
  const recognized = recognizeAgentProcessFromCommandLine(trimmed)
  if (!recognized) {
    return null
  }
  if (
    agentType &&
    recognized.agent !== agentType &&
    !AGENT_IDENTITY_ALIASES_LOWER[agentType]?.includes(recognized.processName.toLowerCase())
  ) {
    return null
  }

  // Definite command line markers: CLI flags or file path separators.
  if (
    tokens
      .slice(1)
      .some(
        (token) => COMMAND_LINE_FLAG_RE.test(token) || /^(?:~|[\\/]|[A-Za-z]:[\\/])/.test(token)
      )
  ) {
    return recognized
  }

  // Bare CLI executable / alias name (e.g. "agy", "agy.exe", "claude").
  const lower = trimmed.toLowerCase()
  const procLower = recognized.processName.toLowerCase()
  if (
    lower === procLower ||
    lower === `${procLower}.exe` ||
    lower === `${procLower}.cmd` ||
    lower === `${procLower}.bat`
  ) {
    return recognized
  }

  return null
}

export function isAgentCommandLineTitle(
  title: string | null | undefined,
  agentType?: AgentType | null | undefined
): boolean {
  return recognizeAgentCommandLine(title, agentType) !== null
}
