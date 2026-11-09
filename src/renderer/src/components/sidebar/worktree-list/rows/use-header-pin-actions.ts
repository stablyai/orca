import { useCallback } from 'react'
import { useAppStore } from '@/store'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'

export function useHeaderPinActions() {
  const updateRepo = useAppStore((s) => s.updateRepo)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)

  const handleTogglePinProject = useCallback(
    (targetRepos: readonly Repo[], nextPinned: boolean) => {
      for (const targetRepo of targetRepos) {
        void updateRepo(
          targetRepo.id,
          { isPinned: nextPinned },
          { hostId: getRepoExecutionHostId(targetRepo) }
        )
      }
    },
    [updateRepo]
  )

  const handleTogglePinProjectGroup = useCallback(
    (groupId: string, nextPinned: boolean, hostId?: ExecutionHostId) => {
      void updateProjectGroup(groupId, { isPinned: nextPinned }, { hostId })
    },
    [updateProjectGroup]
  )

  return { handleTogglePinProject, handleTogglePinProjectGroup }
}
