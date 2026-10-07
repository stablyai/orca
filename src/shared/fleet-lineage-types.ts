import type { GitFileStatus, GitStatusEntry } from './git-status-types'
import type { WorkspaceLineage } from './worktree/lineage-types'
import type {
  LineageMatchSource,
  LineageMember,
  ManualPullRequestLink
} from './lineage-discovery-types'

export type LineageWorktreeStatus = {
  worktreeId: string
  worktreePath: string
  branch: string
  dirtyFiles: GitStatusEntry[] | GitFileStatus[]
  /** Absent on payloads from older hosts; treat as 'lineage'. */
  matchedBy?: LineageMatchSource
  /** Why the worktree was included; absent on payloads from older hosts. */
  reason?: string[]
  /** Remote (SSH) worktree whose files this host could not read; absent from older hosts. */
  unverifiable?: boolean
}

export type LineageProjectStatus = {
  repoName: string
  worktrees: LineageWorktreeStatus[]
  totalDirtyFiles?: number
}

export type LineageGitStatusArgs = {
  parentWorkspaceKey: string
  /** Legacy: older renderers sent keys; hosts that can name the tower ignore them. */
  ticketKeys?: string[]
  /** Bypass the short-lived scan cache (explicit refresh). */
  force?: boolean
}

export type LineageGitStatusPayload = {
  status?: number
  parentKey: string
  parentWorkspaceKey: string
  totalDirtyFiles: number
  projects: Record<string, LineageProjectStatus>
  error?: string
}

export type AttachToParentArgs = {
  parentWorkspaceKey: string
  childWorkspaceKey: string
}

export type AttachToParentResult = {
  status?: number
  success: boolean
  lineageEntry?: WorkspaceLineage
  error?: string
}

export type NotifyWorktreeCreatedArgs = {
  worktreePath: string
  repoName?: string
  branch?: string
  parentWorkspaceKey?: string
}

export type NotifyWorktreeCreatedResult = {
  status?: number
  registered: boolean
  lineageEntry?: WorkspaceLineage
  error?: string
}

export type LineageCommitProjectArgs = {
  worktreePath: string
  message: string
}

export type LineageCommitProjectResult = {
  status?: number
  success: boolean
  commitHash?: string
  error?: string
}

export type LineageGetFileDiffArgs = {
  childWorktreeId?: string
  worktreePath?: string
  filePath: string
  staged: boolean
}

export type LineageGetFileDiffResult = {
  status: 200 | 404 | 500
  patch: string
  original: string
  modified: string
  error?: string
}

export type LineageGetMembersArgs = { parentWorkspaceKey: string; force?: boolean }

export type LineageGetMembersResult = {
  status?: number
  parentWorkspaceKey: string
  keys: string[]
  members: LineageMember[]
  patternError?: string
}

export type LineageManualLinkTarget =
  | { kind: 'worktree'; repoId: string; worktreePath: string }
  | { kind: 'branch'; repoId: string; branch: string }
  | { kind: 'pr'; reference: string }

export type LineageAddManualLinkArgs = {
  parentWorkspaceKey: string
  /** Legacy pull request reference; used when `target` is absent. */
  reference?: string
  /** Absent from older renderers, which send only `reference`. */
  target?: LineageManualLinkTarget
}

export type LineageAddManualLinkResult = {
  success: boolean
  error?: string
  link?: ManualPullRequestLink
}

export type LineageRemoveManualLinkArgs = { parentWorkspaceKey: string; linkId: string }

export type LineageRemoveManualLinkResult = {
  success: boolean
}

export type LineageTestPatternArgs = { towerName: string; keyRegex: string }

export type LineageTestPatternResult = {
  keys: string[]
  error?: string
}
