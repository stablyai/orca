import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import { searchRuntimeRepoBaseRefs } from '@/runtime/runtime-repo-client'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

/** The branch name main derives from a worktree name, without its configured prefix. */
function branchLeafOf(name: string): string {
  return name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
}

/** Unknown counts as taken: main would silently rename a clash to name-2. */
async function mayHaveBranch(
  hostId: ExecutionHostId,
  repoId: string,
  leaf: string
): Promise<boolean> {
  if (!leaf) {
    return true
  }
  try {
    const refs = await searchRuntimeRepoBaseRefs(hostId, repoId, leaf, 50)
    const wanted = leaf.toLowerCase()
    return refs.some((ref) => ref.split('/').at(-1)?.toLowerCase() === wanted)
  } catch {
    return true
  }
}

const SETUP_DECISION_REQUIRED = 'Setup decision required for this repository'

const pendingCreates = new Set<string>()
const pendingListeners = new Set<() => void>()
let pendingVersion = 0

function pendingKey(folderWorkspace: FolderWorkspace, repo: Repo): string {
  return [folderWorkspace.executionHostId ?? '', folderWorkspace.id, repo.id].join('\0')
}

function setPending(key: string, pending: boolean): void {
  if (pending) {
    pendingCreates.add(key)
  } else {
    pendingCreates.delete(key)
  }
  pendingVersion += 1
  pendingListeners.forEach((listener) => listener())
}

export function subscribeFolderRepoCreates(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

export function getFolderRepoCreatesVersion(): number {
  return pendingVersion
}

/** Shared by the three panels, so switching panels mid-create can't start a second one. */
export function isFolderRepoCreatePending(folderWorkspace: FolderWorkspace, repo: Repo): boolean {
  return pendingCreates.has(pendingKey(folderWorkspace, repo))
}

/**
 * Creates a worktree named after the folder workspace in one of its repositories. Creation takes
 * the active folder as its parent and doesn't navigate, so the new section appears in place.
 */
export async function createFolderRepoWorktree(
  folderWorkspace: FolderWorkspace,
  repo: Repo
): Promise<void> {
  const key = pendingKey(folderWorkspace, repo)
  if (pendingCreates.has(key)) {
    return
  }
  setPending(key, true)
  try {
    await createWhileStillInFolder(folderWorkspace, repo)
  } finally {
    setPending(key, false)
  }
}

async function createWhileStillInFolder(
  folderWorkspace: FolderWorkspace,
  repo: Repo
): Promise<void> {
  const name = folderWorkspace.name.trim()
  const hostId = getRepoExecutionHostId(repo)
  const folderHostId = useAppStore.getState().activeWorkspaceExecutionHostId
  // The parent is the active folder at create time; a user who moved on keeps their new view.
  const stillInFolder = (): boolean => {
    const state = useAppStore.getState()
    return (
      state.activeWorkspaceKey === folderWorkspaceKey(folderWorkspace.id) &&
      state.activeWorkspaceExecutionHostId === folderHostId
    )
  }
  const taken = await mayHaveBranch(hostId, repo.id, branchLeafOf(name))
  if (!stillInFolder()) {
    return
  }
  const store = useAppStore.getState()
  const openComposer = (): void => {
    if (!stillInFolder()) {
      return
    }
    store.openModal('new-workspace-composer', {
      initialRepoId: repo.id,
      initialWorkspaceTarget: getRepoWorkspaceCreationTargetHint(repo, store.projectHostSetups),
      prefilledName: name,
      telemetrySource: 'sidebar'
    })
  }
  if (taken) {
    openComposer()
    return
  }
  try {
    await store.createWorktree(
      repo.id,
      name,
      undefined,
      'inherit',
      undefined,
      'sidebar',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { executionHostId: hostId }
    )
    toast.success(
      translate(
        'auto.components.rightSidebar.FolderWorkspaceEmptyState.created',
        'Created worktree {{name}} in {{repo}}',
        { name, repo: repo.displayName }
      )
    )
  } catch (error) {
    // Main refuses before creating anything; the composer is where the user picks run or skip.
    // Local IPC wraps the message ("Error invoking remote method …"); RPC delivers it bare.
    if (readIpcErrorDetail(error) === SETUP_DECISION_REQUIRED) {
      openComposer()
      return
    }
    toast.error(
      error instanceof Error && error.message
        ? error.message
        : translate(
            'auto.components.rightSidebar.FolderWorkspaceEmptyState.createFailed',
            'Could not create a worktree in {{repo}}.',
            { repo: repo.displayName }
          )
    )
  }
}
