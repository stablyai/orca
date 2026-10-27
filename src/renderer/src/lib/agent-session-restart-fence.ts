import {
  agentProviderSessionsEqual,
  normalizeAgentProviderSession,
  type AgentProviderSessionKey,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import type {
  AgentSessionRestartFence,
  AgentSessionRestartPane
} from './agent-session-restart-plan'

/** Pi and Prime Agent compare transcript files. OMP also compares its resume file. */
export function agentSessionRestartSessionMatches(
  fence: AgentSessionRestartFence,
  pane: Pick<AgentSessionRestartPane, 'agent' | 'providerSession' | 'ompResumeFilePath'>
): boolean {
  const current = normalizeAgentProviderSession(pane.providerSession)
  const fenced: AgentProviderSessionMetadata = {
    key: fence.providerSessionKey,
    id: fence.providerSessionId,
    ...(fence.transcriptPath ? { transcriptPath: fence.transcriptPath } : {})
  }
  return (
    pane.agent === fence.agent &&
    agentProviderSessionsEqual(fence.agent, fenced, current ?? undefined) &&
    (fence.ompResumeFilePath ?? null) === (pane.ompResumeFilePath ?? null)
  )
}

export function agentSessionRestartFenceHolds(
  fence: AgentSessionRestartFence,
  current: {
    ptyBoundToTab: boolean
    leafPtyId: string | null
    tabGeneration: number
    agent: string | null
    providerSessionId: string | null
    providerSessionKey: AgentProviderSessionKey | null
    transcriptPath?: string | null
    ompResumeFilePath?: string | null
    worktreeId: string | null
  }
): boolean {
  return (
    current.ptyBoundToTab &&
    current.leafPtyId === fence.ptyId &&
    current.worktreeId === fence.worktreeId &&
    current.tabGeneration === fence.tabGeneration &&
    agentSessionRestartSessionMatches(fence, {
      agent: current.agent ?? '',
      providerSession:
        current.providerSessionId && current.providerSessionKey
          ? {
              key: current.providerSessionKey,
              id: current.providerSessionId,
              ...(current.transcriptPath ? { transcriptPath: current.transcriptPath } : {})
            }
          : null,
      ompResumeFilePath: current.ompResumeFilePath
    })
  )
}
