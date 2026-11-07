import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
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

/**
 * Creates a worktree named after the folder workspace in one of its repositories. Creation takes
 * the active folder as its parent and doesn't navigate, so the new section appears in place.
 */
export async function createFolderRepoWorktree(
  folderWorkspace: FolderWorkspace,
  repo: Repo
): Promise<void> {
  const name = folderWorkspace.name.trim()
  const hostId = getRepoExecutionHostId(repo)
  const taken = await mayHaveBranch(hostId, repo.id, branchLeafOf(name))
  const store = useAppStore.getState()
  // The parent is the active folder at create time; a user who moved on keeps their new view.
  if (store.activeWorkspaceKey !== folderWorkspaceKey(folderWorkspace.id)) {
    return
  }
  if (taken) {
    store.openModal('new-workspace-composer', {
      initialRepoId: repo.id,
      prefilledName: name,
      telemetrySource: 'sidebar'
    })
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
