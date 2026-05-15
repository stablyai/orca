export type WorkspaceSpaceScanStatus =
  | 'ok'
  | 'missing'
  | 'permission-denied'
  | 'unavailable'
  | 'error'

export type WorkspaceSpaceItemKind = 'directory' | 'file' | 'symlink' | 'other'

export type WorkspaceSpaceItem = {
  name: string
  path: string
  kind: WorkspaceSpaceItemKind
  sizeBytes: number
}

export type WorkspaceSpaceWorktree = {
  worktreeId: string
  repoId: string
  repoDisplayName: string
  repoPath: string
  displayName: string
  path: string
  branch: string
  isMainWorktree: boolean
  isRemote: boolean
  isSparse: boolean
  canDelete: boolean
  lastActivityAt: number
  status: WorkspaceSpaceScanStatus
  error: string | null
  scannedAt: number
  sizeBytes: number
  reclaimableBytes: number
  skippedEntryCount: number
  topLevelItems: WorkspaceSpaceItem[]
  omittedTopLevelItemCount: number
  omittedTopLevelSizeBytes: number
}

export type WorkspaceSpaceRepoSummary = {
  repoId: string
  displayName: string
  path: string
  isRemote: boolean
  worktreeCount: number
  scannedWorktreeCount: number
  unavailableWorktreeCount: number
  totalSizeBytes: number
  reclaimableBytes: number
  error: string | null
}

export type WorkspaceSpaceAnalysis = {
  scannedAt: number
  totalSizeBytes: number
  reclaimableBytes: number
  worktreeCount: number
  scannedWorktreeCount: number
  unavailableWorktreeCount: number
  repos: WorkspaceSpaceRepoSummary[]
  worktrees: WorkspaceSpaceWorktree[]
}
