import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { getAgentResumeArgv } from '../../../../shared/agent-launch/startup/agent-resume-argv'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

export type ClosedTerminalAgentResume = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
}

/**
 * Prefer a live agent-status row for the closed tab; fall back to a sleeping
 * record still keyed to that tab (before close retirement clears it).
 */
export function extractClosedTerminalAgentResume(args: {
  tabId: string
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> | undefined
}): ClosedTerminalAgentResume | null {
  const tabPrefix = `${args.tabId}:`
  let bestLive: ClosedTerminalAgentResume | null = null
  let bestLiveUpdatedAt = -1

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey ?? {})) {
    if (!paneKey.startsWith(tabPrefix) && entry.tabId !== args.tabId) {
      continue
    }
    const resume = resumeFromAgentStatusEntry(entry)
    if (!resume) {
      continue
    }
    if (entry.updatedAt >= bestLiveUpdatedAt) {
      bestLive = resume
      bestLiveUpdatedAt = entry.updatedAt
    }
  }
  if (bestLive) {
    return bestLive
  }

  for (const [paneKey, record] of Object.entries(args.sleepingAgentSessionsByPaneKey ?? {})) {
    if (record.tabId !== args.tabId && !paneKey.startsWith(tabPrefix)) {
      continue
    }
    if (!getAgentResumeArgv(record.agent, record.providerSession)) {
      continue
    }
    return {
      agent: record.agent,
      providerSession: record.providerSession,
      ...(record.launchConfig ? { launchConfig: record.launchConfig } : {})
    }
  }

  return null
}

function resumeFromAgentStatusEntry(entry: AgentStatusEntry): ClosedTerminalAgentResume | null {
  const agent = entry.agentType
  if (!isResumableTuiAgent(agent) || !entry.providerSession) {
    return null
  }
  if (!getAgentResumeArgv(agent, entry.providerSession)) {
    return null
  }
  return {
    agent,
    providerSession: entry.providerSession
  }
}
