import { useState, useCallback } from 'react'
import { useAppStore } from '@/store'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { ExecutionHostId } from '../../../../shared/execution-host'

type BaseCompleteGitRepoAdd = (
  repoId: string,
  source: AddRepoExistingWorkspaceSource,
  executionHostId?: ExecutionHostId
) => Promise<void>

export function useAddRepoGroupCompletion(baseComplete: BaseCompleteGitRepoAdd) {
  const projectGroups = useAppStore((s) => s.projectGroups)
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)

  const completeGitRepoAdd = useCallback(
    async (
      repoId: string,
      source: AddRepoExistingWorkspaceSource,
      executionHostId?: ExecutionHostId
    ): Promise<void> => {
      await baseComplete(repoId, source, executionHostId)
      if (selectedGroupId) {
        await moveProjectToGroup(repoId, selectedGroupId)
      }
    },
    [baseComplete, moveProjectToGroup, selectedGroupId]
  )

  return { projectGroups, selectedGroupId, setSelectedGroupId, completeGitRepoAdd }
}
