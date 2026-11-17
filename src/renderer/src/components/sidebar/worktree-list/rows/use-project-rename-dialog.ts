import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'

export type ProjectRenameDialogState = { repo: Repo }

export function useProjectRenameDialog() {
  const updateRepo = useAppStore((s) => s.updateRepo)
  const [projectRenameDialog, setProjectRenameDialog] = useState<ProjectRenameDialogState | null>(
    null
  )

  const handleRenameProject = useCallback((repo: Repo) => {
    setProjectRenameDialog({ repo })
  }, [])

  const handleSubmitProjectRename = useCallback(
    async (name: string) => {
      if (!projectRenameDialog) {
        return
      }
      const { repo } = projectRenameDialog
      const renamed = await updateRepo(
        repo.id,
        { displayName: name },
        { hostId: getRepoExecutionHostId(repo) }
      )
      if (!renamed) {
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.projectRenameFailed',
            'Failed to rename project'
          ),
          {
            description: translate(
              'auto.components.sidebar.WorktreeList.projectRenameFailedDesc',
              // Why: a falsy result also covers RPC timeout/disconnect, so the copy must not assert the host refused.
              "Orca could not confirm the new name with the project's host. Recheck the project after reconnecting."
            )
          }
        )
      }
    },
    [projectRenameDialog, updateRepo]
  )

  return {
    projectRenameDialog,
    setProjectRenameDialog,
    handleRenameProject,
    handleSubmitProjectRename
  }
}
