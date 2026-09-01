import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import type { AgentLaunchResumeRequest } from '../../../../../shared/agent-launch-spawn-request'

export type PendingStartupCommand = {
  command: string
  env?: Record<string, string>
}

export type FreshSpawnOptions = {
  forceBlankRestoredViewport?: boolean
}

export type ColdRestoreAgentResumeStartup = PendingStartupCommand & {
  agent: ResumableTuiAgent
  agentLaunch: AgentLaunchResumeRequest
  resumeProviderSession: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
  legacyResumeRecordedConnectionId?: string | null
  launchToken?: string
  useLiveEntry: boolean
  hasSleepingRecord: boolean
  sleepingRecordEntry: { paneKey: string; record: SleepingAgentSessionRecord } | null
}
