import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

export type ClosedTerminalAgentResume = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
}

type LaunchConfigRegistryLookup = {
  launchConfig: SleepingAgentLaunchConfig
  identity?: { agentType?: string }
}

/**
 * Prefer a live agent-status row for the closed tab; fall back to a sleeping
 * record still keyed to that tab (before close retirement clears it).
 */
export function extractClosedTerminalAgentResume(args: {
  tabId: string
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> | undefined
  /** Why: live status rows do not carry per-launch args/env; the registry does. */
  agentLaunchConfigByPaneKey?: Record<string, LaunchConfigRegistryLookup> | undefined
}): ClosedTerminalAgentResume | null {
  const tabPrefix = `${args.tabId}:`
  let bestLive: ClosedTerminalAgentResume | null = null
  let bestLiveUpdatedAt = -1

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey ?? {})) {
    if (!paneKey.startsWith(tabPrefix) && entry.tabId !== args.tabId) {
      continue
    }
    const resume = resumeFromAgentStatusEntry(entry, args.agentLaunchConfigByPaneKey?.[paneKey])
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

  // Why: prefer newest sleeping record (same as live loop) when a closed tab
  // still has multiple pane keys with sessions (#10386 CodeRabbit).
  let bestSleeping: ClosedTerminalAgentResume | null = null
  let bestSleepingUpdatedAt = -1
  for (const [paneKey, record] of Object.entries(args.sleepingAgentSessionsByPaneKey ?? {})) {
    if (record.tabId !== args.tabId && !paneKey.startsWith(tabPrefix)) {
      continue
    }
    if (!getAgentResumeArgv(record.agent, record.providerSession)) {
      continue
    }
    if (record.updatedAt < bestSleepingUpdatedAt) {
      continue
    }
    bestSleepingUpdatedAt = record.updatedAt
    bestSleeping = {
      agent: record.agent,
      providerSession: record.providerSession,
      ...(record.launchConfig ? { launchConfig: record.launchConfig } : {})
    }
  }

  return bestSleeping
}

function resumeFromAgentStatusEntry(
  entry: AgentStatusEntry,
  registryEntry?: LaunchConfigRegistryLookup
): ClosedTerminalAgentResume | null {
  const agent = entry.agentType
  if (!isResumableTuiAgent(agent) || !entry.providerSession) {
    return null
  }
  if (!getAgentResumeArgv(agent, entry.providerSession)) {
    return null
  }
  // Why: keep per-launch args/env that sleeping-record resume already preserves (#10386).
  const launchConfig =
    registryEntry?.launchConfig &&
    (registryEntry.identity?.agentType === undefined || registryEntry.identity.agentType === agent)
      ? registryEntry.launchConfig
      : undefined
  return {
    agent,
    providerSession: entry.providerSession,
    ...(launchConfig ? { launchConfig } : {})
  }
}
