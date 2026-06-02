import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { AgentType } from './agent-status-types'
import type { TuiAgent } from './types'

export type RecognizedAgentProcess = {
  agent: TuiAgent
  processName: string
}

const EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i

function normalizeProcessName(processName: string | null | undefined): string {
  if (!processName) {
    return ''
  }
  const unquoted = processName.trim().replace(/^["']|["']$/g, '')
  const basename = unquoted.split(/[\\/]/).pop() ?? unquoted
  return basename.toLowerCase().replace(EXTENSION_RE, '')
}

function firstCommandToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

const PROCESS_TO_AGENT = new Map<string, TuiAgent>()
const AGENT_TYPE_IDS = new Set<TuiAgent>()

for (const [agent, config] of Object.entries(TUI_AGENT_CONFIG) as [
  TuiAgent,
  (typeof TUI_AGENT_CONFIG)[TuiAgent]
][]) {
  AGENT_TYPE_IDS.add(agent)
  for (const candidate of [
    config.expectedProcess,
    ...getTuiAgentDetectCommands(config),
    firstCommandToken(config.launchCmd)
  ]) {
    const normalized = normalizeProcessName(candidate)
    if (normalized) {
      PROCESS_TO_AGENT.set(normalized, agent)
    }
  }
}

function agentForNormalizedProcess(normalized: string): TuiAgent | undefined {
  const exact = PROCESS_TO_AGENT.get(normalized)
  if (exact) {
    return exact
  }
  // Why: node-pty can report Codex's packaged platform binary
  // (for example codex-aarch64-ap) instead of the launch command.
  if (normalized.startsWith('codex-')) {
    return PROCESS_TO_AGENT.get('codex')
  }
  return undefined
}

export function isExpectedAgentProcess(
  processName: string | null | undefined,
  expectedProcess: string
): boolean {
  const normalizedProcess = normalizeProcessName(processName)
  const normalizedExpected = normalizeProcessName(expectedProcess)
  if (!normalizedProcess || !normalizedExpected) {
    return false
  }
  return (
    normalizedProcess === normalizedExpected ||
    normalizedProcess.startsWith(`${normalizedExpected}.`)
  )
}

export function recognizeAgentProcess(
  processName: string | null | undefined
): RecognizedAgentProcess | null {
  const normalized = normalizeProcessName(processName)
  const agent = agentForNormalizedProcess(normalized)
  if (!agent) {
    return null
  }
  return { agent, processName: normalized }
}

export function isRecognizedAgentType(agentType: AgentType | null | undefined): boolean {
  if (typeof agentType !== 'string') {
    return false
  }
  return (
    AGENT_TYPE_IDS.has(agentType as TuiAgent) ||
    agentForNormalizedProcess(normalizeProcessName(agentType)) !== undefined
  )
}
