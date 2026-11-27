import type { AgentMessageSender } from '../journal/agent-session-message-source'
import type { OrchestrationPartyLocationResult } from '../../orchestration/orchestration-caller-status'
import type { AgentSessionWorkspaceKind } from '../lifecycle/agent-session-record'

/** `project`: the repo itself left the catalog, so its files may still be on disk. */
export type StructuredSessionRemovedWorkspaceKind = AgentSessionWorkspaceKind | 'project'

export type StructuredSessionOpenTarget = { sessionId: string; worktreeId: string; agent?: string }
export type StructuredSessionOpenSource =
  | {
      kind: 'history'
      structuredSession: { sessionId: string; workspaceId: string }
      agent?: string
    }
  | ({ kind: 'notification' } & StructuredSessionOpenTarget)
  | {
      kind: 'sender'
      party: AgentMessageSender['party']
      messageIds: readonly string[]
      fallback?: StructuredSessionOpenTarget
      displayName?: string
    }
export type StructuredSessionOpenFailure = {
  reason: 'gone' | 'workspace-missing' | 'unknown' | 'unsupported' | 'unreachable'
  beforeEffects: boolean
  code?: string
  surface?: 'terminal'
  workspaceKind?: StructuredSessionRemovedWorkspaceKind
  detail?: string // Raw cause for a details disclosure; never decides a remedy.
}
export type StructuredSessionOpenTab = { id: string; sessionId: string; agent?: string }
export type StructuredSessionOpenInventoryRecheck = {
  recheck: StructuredSessionOpenTarget
  failure: StructuredSessionOpenFailure
}
export type StructuredSessionOpenResult =
  | { kind: 'opened'; target: StructuredSessionOpenTarget; tab: StructuredSessionOpenTab }
  /** `environmentId`: another paired server's terminal, as the answering host names that server. */
  | { kind: 'terminal'; handle: string; environmentId?: string }
  | { kind: 'failed'; failure: StructuredSessionOpenFailure }
  | { kind: 'superseded' }

type Located =
  | OrchestrationPartyLocationResult
  | StructuredSessionOpenFailure
  | StructuredSessionOpenInventoryRecheck
export type StructuredSessionOpenDeps = {
  locate: (address: string, messageIds: readonly string[]) => Promise<Located>
  /** A sender's lookup that may also open a closed worker's conversation; older hosts lack it. */
  open?: (address: string, messageIds: readonly string[]) => Promise<Located>
  tabs: (target: StructuredSessionOpenTarget) => readonly StructuredSessionOpenTab[]
  refresh: (target: StructuredSessionOpenTarget) => Promise<void>
  activate: (
    tab: StructuredSessionOpenTab,
    target: StructuredSessionOpenTarget
  ) => boolean | Promise<boolean>
  reveal: (
    target: StructuredSessionOpenTarget
  ) => Promise<
    | StructuredSessionOpenTarget
    | StructuredSessionOpenFailure
    | StructuredSessionOpenInventoryRecheck
  >
  current?: () => boolean
}
