import type { AgentForkLaunchSource } from '@/lib/agent-session-fork-launch'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type AgentSessionForkModalData = {
  sourceWorktreeId: string
  launchSource: AgentForkLaunchSource
  preselectedPaneKey: string | null
  transcript: { agent: TuiAgent; prompt: string } | null
}

export function buildAgentSessionForkModalData(
  data: AgentSessionForkModalData
): Record<string, unknown> {
  return {
    sourceWorktreeId: data.sourceWorktreeId,
    launchSource: data.launchSource,
    preselectedPaneKey: data.preselectedPaneKey,
    transcript: data.transcript
  }
}

function parseLaunchSource(value: unknown): AgentForkLaunchSource | null {
  return value === 'sidebar' || value === 'terminal_context_menu' ? value : null
}

function parseTranscript(value: unknown): AgentSessionForkModalData['transcript'] {
  if (typeof value !== 'object' || value === null || !('agent' in value) || !('prompt' in value)) {
    return null
  }
  const { agent, prompt } = value
  return isTuiAgent(agent) && typeof prompt === 'string' ? { agent, prompt } : null
}

export function parseAgentSessionForkModalData(
  raw: Record<string, unknown>
): AgentSessionForkModalData | null {
  const launchSource = parseLaunchSource(raw.launchSource)
  if (typeof raw.sourceWorktreeId !== 'string' || !raw.sourceWorktreeId || !launchSource) {
    return null
  }
  return {
    sourceWorktreeId: raw.sourceWorktreeId,
    launchSource,
    preselectedPaneKey: typeof raw.preselectedPaneKey === 'string' ? raw.preselectedPaneKey : null,
    transcript: parseTranscript(raw.transcript)
  }
}
