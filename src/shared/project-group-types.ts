export type ProjectGroupCreatedFrom = 'manual' | 'folder-scan' | 'migration'

export type ProjectGroup = {
  id: string
  name: string
  parentPath: string | null
  /** SSH target ID for folder-backed groups imported from a remote root. */
  connectionId?: string | null
  /** Renderer-owned host stamp for groups fetched from a runtime environment. */
  executionHostId?: string | null
  parentGroupId: string | null
  createdFrom: ProjectGroupCreatedFrom
  tabOrder: number
  rootProjectOrder?: number
  isCollapsed: boolean
  color: string | null
  createdAt: number
  updatedAt: number
}

export type ProjectGroupUpdate = Partial<
  Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>
> & { rootProjectOrder?: number | null }

export type ProjectGroupMutation = { groupId: string; updates: ProjectGroupUpdate }

export type NestedRepoScanOptions = {
  maxDepth?: number
  maxRepos?: number
  timeoutMs?: number | null
}

export type NestedRepoCandidate = {
  path: string
  displayName: string
  depth: number
}

export type NestedRepoScanResult = {
  selectedPath: string
  selectedPathKind: 'git_repo' | 'non_git_folder'
  repos: NestedRepoCandidate[]
  truncated: boolean
  timedOut: boolean
  stopped: boolean
  durationMs: number
  maxDepth: number
  maxRepos: number
  timeoutMs: number | null
}

export type ProjectGroupImportMode = 'group' | 'separate'

export type ProjectGroupImportErrorCode = 'not_in_scan' | 'not_git_repository' | 'import_failed'

export type ProjectGroupImportProjectResult = {
  path: string
  projectId?: string
  status: 'imported' | 'already-known' | 'failed'
  error?: string
  errorCode?: ProjectGroupImportErrorCode
}

export type ProjectGroupImportResult = {
  group?: ProjectGroup
  projects: ProjectGroupImportProjectResult[]
  importedCount: number
  alreadyKnownCount: number
  failedCount: number
}
