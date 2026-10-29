// Share status-to-resume rules with main so accepted hook statuses can checkpoint panes no window opened.

import { agentVerdictFields } from './agent-main-agent-verdict'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from './agent-session-resume'
import type { AgentStatusEntry } from './agent-status-types'
import {
  recoveryRecordMatches,
  recoveryRecordTargetsSameSession,
  sleepingRecordsEquivalentIgnoringCaptureTime
} from './agent-resume-record-equivalence'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from './live-resume-anchor-record'

export type ResumeRecordStatus = Pick<
  AgentStatusEntry,
  | 'paneKey'
  | 'agentType'
  | 'state'
  | 'prompt'
  | 'updatedAt'
  | 'providerSession'
  | 'connectionId'
  | 'terminalTitle'
  | 'lastAssistantMessage'
  | 'terminalResumeEligible'
  | 'interrupted'
  | 'mainAgent'
  | 'worktreeId'
>

export type ResumeRecordTab = { id: string; title?: string }

export function copyLaunchConfig(config: SleepingAgentLaunchConfig): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv },
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {})
  }
}

export function resumeRecordFromStatus(args: {
  entry: ResumeRecordStatus
  worktreeId: string
  /** Read only once the status can leave a record: a snapshot replays hundreds of statuses. */
  tabOf?: () => ResumeRecordTab | undefined
  capturedAt: number
  launchConfig?: SleepingAgentLaunchConfig
  origin?: SleepingAgentSessionRecord['origin']
}): SleepingAgentSessionRecord | null {
  const agent = args.entry.agentType
  if (
    args.entry.terminalResumeEligible === false ||
    !isResumableTuiAgent(agent) ||
    !args.entry.providerSession
  ) {
    return null
  }
  if (!getAgentResumeArgv(agent, args.entry.providerSession)) {
    return null
  }
  const tab = args.tabOf?.()
  return {
    paneKey: args.entry.paneKey,
    ...(tab ? { tabId: tab.id } : {}),
    worktreeId: args.worktreeId,
    agent,
    providerSession: args.entry.providerSession,
    ...(args.entry.connectionId !== undefined ? { connectionId: args.entry.connectionId } : {}),
    prompt: args.entry.prompt,
    state: args.entry.state,
    capturedAt: args.capturedAt,
    updatedAt: args.entry.updatedAt,
    ...((args.entry.terminalTitle ?? tab?.title)
      ? { terminalTitle: (args.entry.terminalTitle ?? tab?.title)! }
      : {}),
    ...(args.entry.lastAssistantMessage
      ? { lastAssistantMessage: args.entry.lastAssistantMessage }
      : {}),
    ...(args.launchConfig ? { launchConfig: copyLaunchConfig(args.launchConfig) } : {}),
    ...agentVerdictFields(args.entry),
    ...(args.origin ? { origin: args.origin } : {})
  }
}

/** A status without a provider session keeps the one its pane's previous status named. */
export function canReuseStatusProviderSession(
  previous: Pick<AgentStatusEntry, 'agentType' | 'state'> | undefined,
  next: Pick<AgentStatusEntry, 'agentType' | 'state'>
): previous is Pick<AgentStatusEntry, 'agentType' | 'state'> {
  return (
    previous !== undefined &&
    previous.agentType === next.agentType &&
    (previous.state !== 'done' || next.state === 'done')
  )
}

/** A finished turn of a resumable agent still names a session its pane can resume. */
export function statusRetainsResumableIdentity(
  status: Pick<AgentStatusEntry, 'agentType' | 'state'>,
  providerSession: AgentProviderSessionMetadata | undefined
): boolean {
  return (
    status.state === 'done' &&
    isResumableTuiAgent(status.agentType) &&
    providerSession !== undefined &&
    getAgentResumeArgv(status.agentType, providerSession) !== null
  )
}

/** The recipe a pane's earlier record kept, when it records this status's own session. */
export function recordLaunchConfigForStatus(
  record: SleepingAgentSessionRecord | undefined,
  status: Pick<AgentStatusEntry, 'agentType' | 'providerSession'>
): SleepingAgentLaunchConfig | undefined {
  return record?.launchConfig &&
    record.agent === status.agentType &&
    status.providerSession &&
    agentProviderSessionsEqual(status.agentType, record.providerSession, status.providerSession)
    ? record.launchConfig
    : undefined
}

/** Checkpoint live sessions for terminal loss; finished resumable sessions retain identity but drop turn text. */
export function liveResumeRecord(args: {
  entry: ResumeRecordStatus
  retainsResumableIdentity: boolean
  /** Read only when the status can leave a record. */
  worktreeIdOf: () => string | null
  tabOf: (worktreeId: string) => ResumeRecordTab | undefined
  capturedAt: number
  launchConfig?: SleepingAgentLaunchConfig
}): SleepingAgentSessionRecord | null {
  const worktreeId =
    args.entry.state === 'done' && !args.retainsResumableIdentity ? null : args.worktreeIdOf()
  return worktreeId
    ? resumeRecordFromStatus({
        entry: args.retainsResumableIdentity
          ? { ...args.entry, prompt: '', lastAssistantMessage: undefined }
          : args.entry,
        worktreeId,
        tabOf: () => args.tabOf(worktreeId),
        capturedAt: args.capturedAt,
        launchConfig: args.launchConfig,
        origin: 'live'
      })
    : null
}

export function liveResumeRecordChange(
  existing: SleepingAgentSessionRecord | undefined,
  live: SleepingAgentSessionRecord | null
): { set: SleepingAgentSessionRecord } | 'clear' | null {
  if (live) {
    return recoveryRecordMatches(existing, live) ? null : { set: live }
  }
  return existing ? 'clear' : null
}

/** Quit captures keep running agents resumable; periodic capture must not replace a quit record. Null leaves the existing record. */
export function capturedResumeRecord(args: {
  entry: ResumeRecordStatus
  existing: SleepingAgentSessionRecord | undefined
  mode: 'quit' | 'periodic'
  capturedAt: number
  worktreeIdOf: () => string | null
  tabOf: (worktreeId: string) => ResumeRecordTab | undefined
  launchConfigOf: () => SleepingAgentLaunchConfig | undefined
}): SleepingAgentSessionRecord | null {
  const { entry, existing, mode, capturedAt } = args
  const origin = mode === 'quit' ? ('quit' as const) : ('live' as const)
  if (entry.state === 'done') {
    if (
      !isCompletedPiCompatibleAgentWithLiveRecoveryRecord(entry, existing) ||
      mode === 'periodic'
    ) {
      return null
    }
    const record = { ...existing, capturedAt, origin }
    return sleepingRecordsEquivalentIgnoringCaptureTime(existing, record) ? null : record
  }
  const worktreeId = args.worktreeIdOf()
  if (!worktreeId) {
    return null
  }
  const record = resumeRecordFromStatus({
    entry,
    worktreeId,
    tabOf: () => args.tabOf(worktreeId),
    capturedAt,
    launchConfig: args.launchConfigOf(),
    origin
  })
  if (
    mode === 'periodic' &&
    existing?.origin === 'quit' &&
    record &&
    recoveryRecordTargetsSameSession(existing, record)
  ) {
    return null
  }
  return record && !sleepingRecordsEquivalentIgnoringCaptureTime(existing, record) ? record : null
}
