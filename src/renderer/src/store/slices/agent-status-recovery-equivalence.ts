import type { AgentProfileSnapshot } from '../../../../shared/agent-launch-profile'
import type {
  SleepingAgentSessionRecord,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'

// Compare durable authority as well as launch arguments before reusing a checkpoint.
function agentProfilesEqual(
  a: AgentProfileSnapshot | undefined,
  b: AgentProfileSnapshot | undefined
): boolean {
  if (!a || !b) {
    return a === b
  }
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.agent === b.agent &&
    a.hostId === b.hostId &&
    a.executable === b.executable &&
    a.resolvedHome === b.resolvedHome &&
    (a.binding.kind === 'managed'
      ? b.binding.kind === 'managed' && a.binding.accountId === b.binding.accountId
      : b.binding.kind === 'external' && a.binding.home === b.binding.home) &&
    (a.identity.kind === 'verified'
      ? b.identity.kind === 'verified' &&
        a.identity.subject === b.identity.subject &&
        a.identity.displayName === b.identity.displayName
      : b.identity.kind === 'unverified' && a.identity.reason === b.identity.reason)
  )
}

export function launchConfigsEqual(
  a: SleepingAgentLaunchConfig | undefined,
  b: SleepingAgentLaunchConfig | undefined
): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  if (
    !agentProfilesEqual(a.agentProfile, b.agentProfile) ||
    a.agentCommand !== b.agentCommand ||
    a.agentArgs !== b.agentArgs ||
    a.claudeAccountId !== b.claudeAccountId ||
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
    agentMainAgentVerdict(existing) === agentMainAgentVerdict(next) &&
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
    agentMainAgentVerdict(existing) === agentMainAgentVerdict(next) &&
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
