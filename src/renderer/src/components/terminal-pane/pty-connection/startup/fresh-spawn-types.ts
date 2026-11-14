import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentSessionRecord
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { SavedResumeStartupSource } from '../../../../../../shared/agent-session/lifecycle/saved-resume-startup-source'
import type { buildAgentResumeStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-resume-startup'

export type PendingStartupCommand = {
  command: string
  resumeSource?: SavedResumeStartupSource
  isCurrent?: () => boolean
  env?: Record<string, string>
}

export type FreshSpawnOptions = {
  forceBlankRestoredViewport?: boolean
  /** Main started the pane without resuming the requested agent session. */
  onAgentResumeUnavailable?: () => void
}

export type ColdRestoreAgentResumeStartup = PendingStartupCommand & {
  agent: ResumableTuiAgent
  resumeProviderSession: AgentProviderSessionMetadata
  connectionId?: string | null
  /** Built from the pane's saved facts, so the host refuses it for a chat's conversation. */
  resumeOrigin: 'saved'
  launchConfig: NonNullable<ReturnType<typeof buildAgentResumeStartupPlan>>['launchConfig']
  launchToken: string
  useLiveEntry: boolean
  hasSleepingRecord: boolean
  sleepingRecordEntry: { paneKey: string; record: SleepingAgentSessionRecord } | null
}
