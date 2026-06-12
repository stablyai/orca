import type { LinkedWorkItemContext } from '@/lib/linked-work-item-context'
import type { TuiAgent, WorkspaceCreateTelemetrySource } from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'

export type LaunchableWorkItem = {
  title: string
  url: string
  type: 'issue' | 'pr' | 'mr'
  number: number | null
  repoId?: string
  pasteContent?: string
  linearIdentifier?: string
  linearWorkspaceId?: string
  linearOrganizationUrlKey?: string
  linkedContext?: LinkedWorkItemContext
}

export type LaunchWorkItemDirectArgs = {
  item: LaunchableWorkItem
  repoId: string
  openModalFallback: () => void
  baseBranch?: string
  launchSource: LaunchSource
  telemetrySource?: WorkspaceCreateTelemetrySource
  agentOverride?: TuiAgent
  agentArgs?: string | null
  promptDelivery?: 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
}
