import type {
  SurfaceExecutionProvenance,
  SurfaceExecutorIdentity
} from './surface-execution-provenance'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type {
  SurfaceCommandIdentity,
  SurfaceCommandOutcome,
  SurfaceContentReplacement,
  SurfaceLayoutRequest,
  SurfaceMoveRequest
} from './surface-command'
import type {
  SurfaceAllocation,
  SurfaceAllocationAcknowledgment,
  SurfaceAllocationOutcome,
  SurfaceResource,
  SurfaceRunTarget
} from './surface-allocation'
import type { SurfaceHostDomain } from './surface-profile-domain'

/** Runtime observations are values; the storage owner never executes a transferred closure. */
export type SurfaceLayoutRuntimeFacts = {
  startingLeafIds: readonly string[]
  bindings: readonly { paneKey: string; ptyId: string; live: boolean; retiring: boolean }[]
}

export type SurfaceStorageCommand = { hostId: string } & (
  | { type: 'initialize' }
  | {
      type: 'layout'
      request: SurfaceLayoutRequest
      session: WorkspaceSessionState
      facts: SurfaceLayoutRuntimeFacts
    }
  | {
      type: 'show-native'
      sessionId: string
      hostTabId: string
      identity: SurfaceCommandIdentity
      expected: {
        workspaceId: string
        hostTabId: string
        occurrence: string
        revision: number
      } | null
    }
  | { type: 'replace'; request: SurfaceContentReplacement }
  | { type: 'move'; request: SurfaceMoveRequest }
  | {
      type: 'begin-run'
      target: SurfaceRunTarget
      resourceId: string
      executorId?: string
      provenance?: SurfaceExecutionProvenance | null
    }
  | { type: 'bind-run'; allocationId: string; resource: SurfaceResource }
  | { type: 'abort-run'; allocationId: string }
  | { type: 'acknowledge-run'; acknowledgment: SurfaceAllocationAcknowledgment }
  | { type: 'retire-kernel-run'; subject: SurfaceAllocation; observer: SurfaceExecutorIdentity }
  | { type: 'query'; command?: { callerId: string; commandId: string } }
)

export type SurfaceHostSnapshot = Pick<
  SurfaceHostDomain,
  'terminalInitialized' | 'chatInitialization' | 'revision' | 'surfaces'
> & { nativeTabs?: readonly { tabId: string; sessionId: string }[] }

export type SurfaceStorageResult = {
  hostId: string
  host: SurfaceHostSnapshot
  session: WorkspaceSessionState
  allocations: readonly SurfaceAllocation[]
  outcome: SurfaceCommandOutcome | SurfaceAllocationOutcome | SurfaceAllocation | boolean | null
}

export type SurfaceStorageMutation = Exclude<SurfaceStorageCommand, { type: 'query' }>
