import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { getProjectGroupingIndexFromState } from '../store/project-host-setup-selector'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ResumeWorkspaceGroup } from './native-chat-resume-on-restart-grouping'

export function useResumeProjectGroupKeys(
  hostId: ExecutionHostId,
  workspaces: readonly ResumeWorkspaceGroup[],
  repoIdFor: (id: string) => string | null
): string[] {
  const selectKeys = useMemo(() => {
    let previousIndex: ReturnType<typeof getProjectGroupingIndexFromState> | undefined
    let keys: string[] = []
    return (state: Parameters<typeof getProjectGroupingIndexFromState>[0]) => {
      const index = getProjectGroupingIndexFromState(state)
      if (index !== previousIndex) {
        keys = workspaces.map((workspace) => {
          const repoId = repoIdFor(workspace.workspaceId)
          return index.groupByRepoHost.get(`${hostId}\0${repoId}`)?.key ?? repoId ?? '\0none'
        })
        previousIndex = index
      }
      return keys
    }
  }, [workspaces, repoIdFor, hostId])
  return useAppStore(useShallow(selectKeys))
}
