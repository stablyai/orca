import type { ExecutionHostId } from './execution-host'
import type { TaskSourceContext } from './task-source-context'
import type { TuiAgent } from './tui-agent'
import type { DiffComment } from './diff-comment-types'
import type { SmartTier } from './sidebar-list/sort-stamps'
import type { OrcadRetainedMarker } from './orcad-retained-marker'
import type { ExternalConversationLink } from './external-conversation-link'
import type {
  WorkspaceCreatorProvenance,
  WorkspaceLinkedItem,
  WorkspaceAttachment,
  WorkspaceStatus
} from './worktree/types'

export type WorkspaceScope =
  | { type: 'worktree'; worktreeId: string }
  | { type: 'folder'; folderWorkspaceId: string }

export type WorkspaceKey = `worktree:${string}` | `folder:${string}`

export type FolderWorkspace = {
  id: string
  projectGroupId: string
  name: string
  folderPath: string
  /** SSH target ID for folder workspaces whose folder path lives remotely. */
  connectionId?: string | null
  /** Renderer-owned host stamp for host-qualified folder catalogs. */
  executionHostId?: ExecutionHostId | null
  /** Authenticated client that created this workspace. Missing means unknown legacy origin. */
  creatorProvenance?: WorkspaceCreatorProvenance
  linkedTask: WorkspaceLinkedItem | null
  linkedItems?: WorkspaceAttachment[]
  linkedTaskSourceContext?: TaskSourceContext | null
  comment: string
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  /** User-authored sidebar ordering. Higher values render earlier in Manual sort. */
  manualOrder?: number
  workspaceStatus?: WorkspaceStatus
  createdWithAgent?: TuiAgent
  pendingFirstAgentMessageRename?: boolean
  firstAgentMessageRenameError?: string | null
  lastActivityAt: number
  smartTier?: SmartTier
  smartAt?: number
  lastTerminalUseAt?: number
  createdAt: number
  updatedAt: number
  diffComments?: DiffComment[]
  /** Local row a WSL host now owns, kept for a downgrade; set only by the mover's retention pass. */
  orcadRetained?: OrcadRetainedMarker
  /** See {@link WorktreeMeta.externalConversations}. */
  externalConversations?: ExternalConversationLink[]
}

export type FolderWorkspaceLinkedTask = WorkspaceLinkedItem
