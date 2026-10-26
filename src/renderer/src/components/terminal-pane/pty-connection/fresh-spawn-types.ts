import type { TerminalStartupInput } from '../../../../../shared/agent-terminal-resume'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SavedResumeStartupSource,
  SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import type { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'

export type PendingStartupCommand = {
  resumeSource?: SavedResumeStartupSource
  isCurrent?: () => boolean
  env?: Record<string, string>
} & TerminalStartupInput

export type FreshSpawnOptions = {
  forceBlankRestoredViewport?: boolean
  /** Main started the pane without resuming the requested agent session. */
  onAgentResumeUnavailable?: () => void
}

export type ColdRestoreAgentResumeStartup = PendingStartupCommand & {
  agent: ResumableTuiAgent
  resumeProviderSession: AgentProviderSessionMetadata
  /** Built from the pane's saved facts, so the host refuses it for a chat's conversation. */
  resumeOrigin: 'saved'
  launchConfig?: NonNullable<ReturnType<typeof buildAgentResumeStartupPlan>>['launchConfig']
  launchToken: string
  useLiveEntry: boolean
  hasSleepingRecord: boolean
  sleepingRecordEntry: { paneKey: string; record: SleepingAgentSessionRecord } | null
}
