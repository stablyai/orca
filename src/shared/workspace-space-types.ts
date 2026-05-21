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

export type WorkspacePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export type WorkspacePackageManagerCacheCleanupSafety = 'safe' | 'aggressive'

export type WorkspacePackageManagerCacheCleanupAction = {
  id: string
  packageManager: WorkspacePackageManager
  safety: WorkspacePackageManagerCacheCleanupSafety
  binary: string
  args: string[]
  command: string
  label: string
  description: string
}

export type WorkspacePackageManagerCacheTargetWorktree = {
  worktreeId: string
  lockfiles: string[]
}

export type WorkspacePackageManagerCacheTarget = {
  id: string
  packageManager: WorkspacePackageManager
  connectionId: string | null
  isRemote: boolean
  targetLabel: string
  cwd: string
  cachePath: string | null
  detectedWorktreeCount: number
  detectedWorktrees: WorkspacePackageManagerCacheTargetWorktree[]
  detectedLockfiles: string[]
  cliAvailable: boolean
  unavailableReason: string | null
  cleanupActions: WorkspacePackageManagerCacheCleanupAction[]
}

export type WorkspacePackageManagerCacheCleanupRequest = {
  targetId: string
  actionId: string
  packageManager: WorkspacePackageManager
  connectionId: string | null
  cwd: string
}

export type WorkspacePackageManagerCacheCleanupResult =
  | {
      ok: true
      action: WorkspacePackageManagerCacheCleanupAction
      stdout: string
      stderr: string
      cachePath: string | null
      cacheSizeBeforeBytes: number | null
      cacheSizeAfterBytes: number | null
      reclaimedBytes: number | null
    }
  | { ok: false; error: string }

export type WorkspaceSpaceAnalysis = {
  scannedAt: number
  totalSizeBytes: number
  reclaimableBytes: number
  worktreeCount: number
  scannedWorktreeCount: number
  unavailableWorktreeCount: number
  packageManagerCaches: WorkspacePackageManagerCacheTarget[]
  repos: WorkspaceSpaceRepoSummary[]
  worktrees: WorkspaceSpaceWorktree[]
}

export type WorkspaceSpaceAnalyzeResult =
  | { ok: true; analysis: WorkspaceSpaceAnalysis }
  | { ok: false; cancelled: true }

export type WorkspaceSpaceDirectoryScanResult = {
  sizeBytes: number
  skippedEntryCount: number
  topLevelItems: WorkspaceSpaceItem[]
  omittedTopLevelItemCount: number
  omittedTopLevelSizeBytes: number
}

export type WorkspaceSpaceScanProgress = {
  scanId: string
  state: 'running' | 'cancelling'
  startedAt: number
  updatedAt: number
  totalRepoCount: number
  scannedRepoCount: number
  totalWorktreeCount: number
  scannedWorktreeCount: number
  currentRepoDisplayName: string | null
  currentWorktreeDisplayName: string | null
}
