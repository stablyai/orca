import type { ResolveProjectExecutionRuntimeArgs } from '../../../shared/project-execution-runtime'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  findLocalFolderWorkspaceRuntimeRepo,
  resolveQualifiedFolderWorkspaceResult,
  type FolderWorkspaceHostState
} from '../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type RuntimeWorkspaceState = Pick<AppState, 'activeWorktreeId' | 'repos' | 'worktreesByRepo'> &
  Partial<Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'activeWorkspaceExecutionHostId'>>

export type LocalProjectRuntimeState = RuntimeWorkspaceState &
  Pick<AppState, 'activeRepoId' | 'projects' | 'settings'>

const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}

const EMPTY_FOLDERS: NonNullable<RuntimeWorkspaceState['folderWorkspaces']> = []
const EMPTY_GROUPS: NonNullable<RuntimeWorkspaceState['projectGroups']> = []
type RuntimeWorkspace = Pick<Worktree, 'id' | 'repoId' | 'projectId' | 'path' | 'hostId'> | null
const folderIndexes = new WeakMap<typeof EMPTY_FOLDERS, Map<string, typeof EMPTY_FOLDERS>>()
const folderRuntimeCache = new WeakMap<
  (typeof EMPTY_FOLDERS)[number],
  WeakMap<typeof EMPTY_GROUPS, WeakMap<AppState['repos'], { workspace: RuntimeWorkspace }>>
>()

function getIndexedFolders(folders: typeof EMPTY_FOLDERS, id: string) {
  let byId = folderIndexes.get(folders)
  if (!byId) {
    byId = new Map()
    for (const folder of folders) {
      const folderId = folder.id
      const rows = byId.get(folderId) ?? []
      rows.push(folder)
      byId.set(folderId, rows)
    }
    folderIndexes.set(folders, byId)
  }
  return byId.get(id) ?? EMPTY_FOLDERS
}

export function createLocalProjectRuntimeWorkspaceSelector(): typeof getLocalProjectRuntimeWorkspace {
  let previous: readonly unknown[] | undefined
  let workspace: RuntimeWorkspace = null
  return (state, worktreeId, selectedFolder) => {
    const scope = parseWorkspaceKey(worktreeId ?? state.activeWorktreeId ?? '')
    if (scope?.type !== 'folder') {
      previous = undefined
      workspace = null
      return getLocalProjectRuntimeWorkspace(state, worktreeId, selectedFolder)
    }
    const folders = selectedFolder
      ? [selectedFolder]
      : getIndexedFolders(state.folderWorkspaces ?? EMPTY_FOLDERS, scope.folderWorkspaceId)
    const facts = [
      scope.folderWorkspaceId,
      ...folders.flatMap((folder) => [
        folder.folderPath,
        folder.projectGroupId,
        folder.executionHostId,
        folder.connectionId
      ]),
      state.projectGroups,
      state.repos,
      (worktreeId ?? state.activeWorktreeId) === state.activeWorktreeId
        ? state.activeWorkspaceExecutionHostId
        : undefined
    ]
    if (
      !previous ||
      facts.length !== previous.length ||
      facts.some((value, index) => value !== previous?.[index])
    ) {
      previous = facts
      workspace = getLocalProjectRuntimeWorkspace(state, worktreeId, selectedFolder)
    }
    return workspace
  }
}

export function getProjectRuntimeFolder(
  state: RuntimeWorkspaceState,
  worktreeId: string,
  hostId?: ExecutionHostId
) {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  const result = resolveQualifiedFolderWorkspaceResult(
    state,
    scope.folderWorkspaceId,
    hostId ??
      (worktreeId === state.activeWorktreeId
        ? (state.activeWorkspaceExecutionHostId ?? undefined)
        : undefined)
  )
  return result.kind === 'selected' ? result.value : null
}

export function getLocalProjectRuntimeWorkspace(
  state: RuntimeWorkspaceState,
  worktreeId?: string | null,
  selectedFolder?: FolderWorkspace
): RuntimeWorkspace {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  if (!targetWorktreeId) {
    return null
  }
  const scope = parseWorkspaceKey(targetWorktreeId)
  if (scope?.type !== 'folder') {
    return (
      getIndexedWorktreeById(
        selectWorktreesByRepo(state) ?? EMPTY_WORKTREES_BY_REPO,
        targetWorktreeId
      ) ?? null
    )
  }
  const folders = state.folderWorkspaces ?? EMPTY_FOLDERS
  const groups = state.projectGroups ?? EMPTY_GROUPS
  const folderState = { folderWorkspaces: folders, projectGroups: groups, repos: state.repos }
  if (selectedFolder) {
    return resolveLocalFolderRuntimeWorkspace(
      folderState,
      targetWorktreeId,
      scope.folderWorkspaceId,
      selectedFolder
    )
  }
  const selected = getProjectRuntimeFolder(state, targetWorktreeId)
  if (!selected) {
    return null
  }
  const folder = selected.workspace
  let byGroups = folderRuntimeCache.get(folder)
  if (!byGroups) {
    byGroups = new WeakMap()
    folderRuntimeCache.set(folder, byGroups)
  }
  let byRepos = byGroups.get(groups)
  if (!byRepos) {
    byRepos = new WeakMap()
    byGroups.set(groups, byRepos)
  }
  const cached = byRepos.get(state.repos)
  if (cached) {
    return cached.workspace
  }
  const result = resolveLocalFolderRuntimeWorkspace(
    folderState,
    targetWorktreeId,
    scope.folderWorkspaceId,
    {
      ...selected.workspace,
      executionHostId: selected.hostId,
      connectionId: selected.connectionId
    }
  )
  byRepos.set(state.repos, { workspace: result })
  return result
}

function resolveLocalFolderRuntimeWorkspace(
  folderState: FolderWorkspaceHostState,
  targetWorktreeId: string,
  folderWorkspaceId: string,
  folder: (typeof EMPTY_FOLDERS)[number]
): RuntimeWorkspace {
  const repo = findLocalFolderWorkspaceRuntimeRepo(folderState, folderWorkspaceId, folder)
  return repo
    ? {
        id: targetWorktreeId,
        repoId: repo.id,
        path: folder.folderPath,
        hostId: getRepoExecutionHostId(folder)
      }
    : null
}

export function getLocalPreflightProjectId(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null,
  readWorkspace = getLocalProjectRuntimeWorkspace
): string {
  const activeWorktree = readWorkspace(state, worktreeId)
  return (
    activeWorktree?.projectId ?? activeWorktree?.repoId ?? state.activeRepoId ?? 'local-project'
  )
}

export function getGlobalWindowsExecutionRuntimeInput(
  state: LocalProjectRuntimeState,
  worktreeId: string | null | undefined,
  appPlatform: NodeJS.Platform,
  wslContext: Pick<ResolveProjectExecutionRuntimeArgs, 'wslAvailable' | 'availableWslDistros'>,
  readWorkspace = getLocalProjectRuntimeWorkspace
): ResolveProjectExecutionRuntimeArgs | undefined {
  if (
    appPlatform !== 'win32' ||
    worktreeId ||
    state.activeRepoId ||
    state.activeWorktreeId ||
    !state.settings?.localWindowsRuntimeDefault
  ) {
    return undefined
  }
  return {
    appPlatform: 'win32',
    projectId: getLocalPreflightProjectId(state, worktreeId, readWorkspace),
    projectRuntimePreference: { kind: 'inherit-global' },
    globalWindowsRuntimeDefault: state.settings.localWindowsRuntimeDefault,
    ...wslContext
  }
}
