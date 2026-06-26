import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { toDevcontainerExecutionHostId } from '../../../../shared/execution-host'
import {
  DEVCONTAINER_WORKTREE_BASE_PATH,
  type DevcontainerInfo
} from '../../../../shared/devcontainer-types'

/**
 * Add-Project "Devcontainer" flow: create a repo on the devcontainer's host
 * bind-mount folder, then bind it to the devcontainer execution host so the
 * terminal runs via `docker exec` and worktrees live inside the mount.
 */
export function useAddRepoDevcontainerFlow({
  setIsAdding,
  onDone
}: {
  setIsAdding: (busy: boolean) => void
  onDone: () => void
}): { handleSelectDevcontainer: (info: DevcontainerInfo) => Promise<void> } {
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const updateRepo = useAppStore((s) => s.updateRepo)

  const handleSelectDevcontainer = useCallback(
    async (info: DevcontainerInfo) => {
      setIsAdding(true)
      try {
        const repo = await addRepoPath(info.hostFolder, 'folder')
        if (repo) {
          const hostId = toDevcontainerExecutionHostId(info.hostFolder)
          await updateRepo(repo.id, {
            executionHostId: hostId,
            connectionId: hostId,
            worktreeBasePath: DEVCONTAINER_WORKTREE_BASE_PATH
          })
        }
      } finally {
        setIsAdding(false)
        onDone()
      }
    },
    [addRepoPath, updateRepo, setIsAdding, onDone]
  )

  return { handleSelectDevcontainer }
}
