import type {
  SleepingAgentSessionRecord,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'

export function launchConfigsEqual(
  a: SleepingAgentLaunchConfig | undefined,
  b: SleepingAgentLaunchConfig | undefined
): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  if (
    a.agentCommand !== b.agentCommand ||
    a.agentArgs !== b.agentArgs ||
    a.ompResumeFilePath !== b.ompResumeFilePath
  ) {
    return false
  }
  const aKeys = Object.keys(a.agentEnv)
  const bKeys = Object.keys(b.agentEnv)
  return aKeys.length === bKeys.length && aKeys.every((key) => a.agentEnv[key] === b.agentEnv[key])
}

export function sleepingRecordsEquivalentIgnoringCaptureTime(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.paneKey === next.paneKey &&
    existing.tabId === next.tabId &&
    existing.worktreeId === next.worktreeId &&
    existing.agent === next.agent &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession) &&
    existing.prompt === next.prompt &&
    existing.state === next.state &&
    existing.updatedAt === next.updatedAt &&
    existing.terminalTitle === next.terminalTitle &&
    existing.lastAssistantMessage === next.lastAssistantMessage &&
    existing.interrupted === next.interrupted &&
    existing.origin === next.origin &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
  )
}

export function recoveryRecordMatches(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  // Why: completion or interruption must replace a pre-status working checkpoint.
  return (
    existing.origin === next.origin &&
    existing.agent === next.agent &&
    existing.worktreeId === next.worktreeId &&
    existing.tabId === next.tabId &&
    existing.state === next.state &&
    existing.interrupted === next.interrupted &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession) &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
  )
}

export function recoveryRecordTargetsSameSession(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.agent === next.agent &&
    existing.worktreeId === next.worktreeId &&
    existing.tabId === next.tabId &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession)
  )
}
