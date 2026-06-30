import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { toDevcontainerExecutionHostId } from '../../../../shared/execution-host'
import {
  DEVCONTAINER_WORKTREE_BASE_PATH,
  type DevcontainerInfo
} from '../../../../shared/devcontainer-types'
import type { Repo } from '../../../../shared/types'

/**
 * Add-Project "Devcontainer" flow: create a repo on the devcontainer's host
 * bind-mount folder, then bind it to the devcontainer execution host so the
 * terminal runs via `docker exec` and worktrees live inside the mount.
 */
export function useAddRepoDevcontainerFlow({
  setIsAdding,
  onRepoReady,
  onDone
}: {
  setIsAdding: (busy: boolean) => void
  onRepoReady: (repoId: string) => Promise<void>
  onDone: () => void
}): { handleSelectDevcontainer: (info: DevcontainerInfo) => Promise<void> } {
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const removeProject = useAppStore((s) => s.removeProject)

  const handleSelectDevcontainer = useCallback(
    async (info: DevcontainerInfo) => {
      setIsAdding(true)
      let repo: Repo | null = null
      try {
        // Why: devcontainer projects should preserve git capabilities when the
        // mounted host folder is a repo. `addRepoPath(..., 'git')` keeps SCM and
        // worktree wiring intact instead of downgrading to folder mode.
        repo = await addRepoPath(info.hostFolder, 'git')
        if (!repo) {
          return
        }
        const hostId = toDevcontainerExecutionHostId(info.hostFolder)
        const updated = await updateRepo(repo.id, {
          executionHostId: hostId,
          connectionId: hostId,
          worktreeBasePath: DEVCONTAINER_WORKTREE_BASE_PATH
        }).catch(() => false)
        if (!updated) {
          // Why: if the devcontainer routing update fails, remove the transient
          // repo row so the Add-Project flow does not leave a half-configured entry.
          await removeProject(repo.id)
          return
        }
        await onRepoReady(repo.id)
        onDone()
      } finally {
        setIsAdding(false)
      }
    },
    [addRepoPath, onDone, onRepoReady, removeProject, setIsAdding, updateRepo]
  )

  return { handleSelectDevcontainer }
}
