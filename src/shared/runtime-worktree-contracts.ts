import type { AgentStatusState, AgentType, AgentWorkingMode } from './agent-status-types'
import type { BaseRefSearchResult, Repo } from './repo-types'
import type { CreateWorktreeResult, RemoveWorktreeResult } from './worktree/create-types'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from './worktree/lineage-types'
import type { RuntimeListingHostScope } from './runtime-listing-host-scope'
import type { GitWorktreeInfo, Worktree } from './worktree/types'
import { parseExecutionHostId, type ExecutionHostId } from './execution-host'

export type RuntimeWorktreeAgentRow = {
  paneKey: string
  parentPaneKey: string | null
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  agentType: AgentType | null
  prompt: string
  taskTitle: string | null
  displayName: string | null
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  stateStartedAt: number
  updatedAt: number
  restoredUnconfirmed?: boolean
  /** The structured session host still runs this row's provider child, so it is fresh regardless
   *  of age. Optional on the wire: old hosts never send it. */
  structuredHostOwned?: true
}

export type RuntimeWorktreePsSummary = {
  workspaceKind?: 'git' | 'folder-workspace'
  worktreeId: string
  repoId: string
  hostId?: Worktree['hostId']
  terminalPlatform?: NodeJS.Platform
  repo: string
  path: string
  branch: string
  isArchived: boolean
  isMainWorktree: boolean
  hasHostSidebarActivity: boolean
  worktreeInstanceId?: string
  lineageWorktreeInstanceId?: string
  parentWorktreeInstanceId?: string
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  displayName: string
  workspaceStatus: string
  sortOrder: number
  manualOrder?: number
  lastActivityAt?: number
  createdAt?: number
  creatorProvenance?: Worktree['creatorProvenance']
  linkedIssue: number | null
  linkedPR: { number: number; state: string } | null
  linkedLinearIssue: string | null
  linkedGitLabMR: number | null
  linkedGitLabIssue: number | null
  comment: string
  isPinned: boolean
  isActive: boolean
  unread: boolean
  liveTerminalCount: number
  hasAttachedPty: boolean
  lastOutputAt: number | null
  preview: string
  status: RuntimeWorktreeStatus
  /** Optional discriminator for a working workspace; older clients fall back to ordinary working. */
  workingMode?: AgentWorkingMode
  agents: RuntimeWorktreeAgentRow[]
}

export type RuntimeGitLocalBranches = {
  current: string | null
  branches: string[]
}

export type RuntimeSpeechModelSummary = {
  id: string
  label: string
  provider: 'local' | 'openai'
  sizeBytes: number | null
  recommended: boolean
  status: 'ready' | 'not-downloaded' | 'downloading' | 'extracting' | 'error'
  progress: number | null
}

export type RuntimeSpeechSetupState = {
  enabled: boolean
  selectedModelId: string
  dictationMode: 'toggle' | 'hold'
  models: RuntimeSpeechModelSummary[]
}

export type RuntimeGitCheckoutResult = {
  ok: true
  branch: string
}

export type RuntimeWorktreeStatus = 'active' | 'working' | 'permission' | 'done' | 'inactive'

export type RuntimeWorktreeRecord = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  git: GitWorktreeInfo
}

export type RuntimeWorktreeCreateResult = {
  worktree: RuntimeWorktreeRecord
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  warnings: WorktreeLineageWarning[]
  warning?: string
  startupTerminal?: CreateWorktreeResult['startupTerminal']
  agentTerminalHandle?: string
}

export type RuntimeWorktreeRemoveResult = RemoveWorktreeResult & {
  removed: boolean
  warning?: string
}

export type RuntimeRunWorktreeCleanupDisposition =
  | 'removed'
  | 'already_absent'
  | 'retained'
  | 'pending'
  | 'unverifiable'

export type RuntimeRunWorktreeCleanupResult = {
  worktreeId: string
  executionHostId?: string
  disposition: RuntimeRunWorktreeCleanupDisposition
  cause?: string
  action?: string
}

export type RuntimeRunSettlementResult = {
  runId: string
  state: 'settled' | 'pending' | 'unverifiable'
  worktrees: RuntimeRunWorktreeCleanupResult[]
  warnings: string[]
}

export function collectRunOwnedChildWorktrees(rows: readonly { effects: string }[]): {
  worktrees: {
    worktreeId: string
    executionHostId?: ExecutionHostId
    worktreeInstanceId?: string
  }[]
  unreadableEffectRows: number
} {
  const owned = new Map<
    string,
    { worktreeId: string; executionHostId?: ExecutionHostId; worktreeInstanceId?: string }
  >()
  let unreadableEffectRows = 0
  for (const row of rows) {
    let effects: unknown
    try {
      effects = JSON.parse(row.effects)
    } catch {
      unreadableEffectRows += 1
      continue
    }
    if (!Array.isArray(effects)) {
      continue
    }
    for (const effect of effects) {
      if (
        !effect ||
        typeof effect !== 'object' ||
        (effect as { kind?: unknown }).kind !== 'worktree' ||
        (effect as { action?: unknown }).action !== 'created_child' ||
        typeof (effect as { id?: unknown }).id !== 'string'
      ) {
        continue
      }
      const worktreeId = (effect as { id: string }).id
      const rawHostId = (effect as { executionHostId?: unknown }).executionHostId
      const executionHostId = parseExecutionHostId(
        typeof rawHostId === 'string' ? rawHostId : undefined
      )?.id
      const rawInstanceId = (effect as { worktreeInstanceId?: unknown }).worktreeInstanceId
      const worktreeInstanceId =
        typeof rawInstanceId === 'string' && rawInstanceId.trim() ? rawInstanceId : undefined
      owned.set(
        `${executionHostId ?? 'unverifiable'}\0${worktreeId}\0${worktreeInstanceId ?? 'legacy'}`,
        {
          worktreeId,
          ...(executionHostId ? { executionHostId } : {}),
          ...(worktreeInstanceId ? { worktreeInstanceId } : {})
        }
      )
    }
  }
  return { worktrees: [...owned.values()], unreadableEffectRows }
}

export type RuntimeWorktreePsResult = {
  worktrees: RuntimeWorktreePsSummary[]
  totalCount: number
  truncated: boolean
  /** Hosts covered by the live process inventory used for this snapshot. */
  queriedHostIds?: ExecutionHostId[]
  /** Absent from hosts that predate the field; treat that scope as unverifiable. */
  hostScope?: RuntimeListingHostScope
}

export type RuntimeWorktreePsSnapshotResult = RuntimeWorktreePsResult & { snapshotId: string }

export type RuntimeWorktreePsUnchangedResult = {
  unchanged: true
  snapshotId: string
}

export type RuntimeWorktreePsConditionalResult =
  | RuntimeWorktreePsSnapshotResult
  | RuntimeWorktreePsUnchangedResult

export type RuntimeRepoList = { repos: Repo[] }

export type RuntimeRepoSearchRefs = {
  refs: string[]
  refDetails?: BaseRefSearchResult[]
  truncated: boolean
}

export type RuntimeWorktreeListResult = {
  worktrees: RuntimeWorktreeRecord[]
  totalCount: number
  truncated: boolean
  /** Absent from hosts that predate the field; treat that scope as unverifiable. */
  hostScope?: RuntimeListingHostScope
}
