import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import type { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'

export type PendingStartupCommand = {
  command: string
  env?: Record<string, string>
}

export type FreshSpawnOptions = {
  forceBlankRestoredViewport?: boolean
}

export type ColdRestoreAgentResumeStartup = PendingStartupCommand & {
  agent: ResumableTuiAgent
  resumeProviderSession: AgentProviderSessionMetadata
  launchConfig: NonNullable<ReturnType<typeof buildAgentResumeStartupPlan>>['launchConfig']
  launchToken: string
  useLiveEntry: boolean
  hasSleepingRecord: boolean
  sleepingRecordEntry: { paneKey: string; record: SleepingAgentSessionRecord } | null
}
