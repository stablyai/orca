import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getSpaceById, isRepoInSpace } from '../../../../shared/spaces'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo, Space } from '../../../../shared/types'
import type { CompleteAddedGitRepo } from './add-repo-dialog-types'
import type { AddRepoSpaceConflictView } from './AddRepoSpaceConflictStep'

type PendingSpaceConflict = {
  repo: Repo
  sourceSpace: Space
  targetSpace: Space
  executionHostId: ExecutionHostId
  finish: () => Promise<void>
}

export function useAddRepoSpaceConflict({
  finishGitRepoAdd,
  onConflict
}: {
  finishGitRepoAdd: CompleteAddedGitRepo
  onConflict: () => void
}): {
  completeGitRepoAdd: CompleteAddedGitRepo
  conflictView: AddRepoSpaceConflictView | null
  error: string | null
  isResolving: boolean
  moveToActiveSpace: () => Promise<void>
  openSourceSpace: () => Promise<void>
  resetSpaceConflict: () => void
} {
  const [conflict, setConflict] = useState<PendingSpaceConflict | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isResolving, setIsResolving] = useState(false)
  const resolutionGenerationRef = useRef(0)

  const resetSpaceConflict = useCallback((): void => {
    resolutionGenerationRef.current++
    setConflict(null)
    setError(null)
    setIsResolving(false)
  }, [])

  const completeGitRepoAdd = useCallback<CompleteAddedGitRepo>(
    async (repoId, source, executionHostId, alreadyPresent = false) => {
      const finish = () => finishGitRepoAdd(repoId, source, executionHostId)
      if (!alreadyPresent) {
        await finish()
        return
      }
      const state = useAppStore.getState()
      const isRuntime = parseExecutionHostId(executionHostId)?.kind === 'runtime'
      const repo = isRuntime
        ? undefined
        : findRepoForHost(state.repos, repoId, { hostId: executionHostId })
      const targetSpace = getSpaceById(state.spaces, state.activeSpaceId)
      const sourceSpace = repo ? getSpaceById(state.spaces, repo.spaceId) : undefined
      if (repo && targetSpace && sourceSpace && !isRepoInSpace(repo, targetSpace.id)) {
        setConflict({
          repo,
          sourceSpace,
          targetSpace,
          executionHostId: getRepoExecutionHostId(repo),
          finish
        })
        setError(null)
        onConflict()
        return
      }
      toast.info(
        repo && targetSpace
          ? translate(
              'auto.components.sidebar.useAddRepoSpaceConflict.58f69327ca',
              'Project already in {{spaceName}}',
              { spaceName: targetSpace.name }
            )
          : translate(
              'auto.components.sidebar.useAddRepoSpaceConflict.75699542b5',
              'Project already added'
            ),
        { description: repo?.displayName }
      )
      await finish()
    },
    [finishGitRepoAdd, onConflict]
  )

  const moveToActiveSpace = useCallback(async (): Promise<void> => {
    if (!conflict || isResolving) {
      return
    }
    const generation = ++resolutionGenerationRef.current
    setError(null)
    setIsResolving(true)
    const moved = await useAppStore
      .getState()
      .moveProjectToSpace(conflict.repo.id, conflict.targetSpace.id, conflict.executionHostId)
    if (generation !== resolutionGenerationRef.current) {
      return
    }
    if (!moved) {
      setError(
        translate(
          'auto.components.sidebar.useAddRepoSpaceConflict.63ac3b7d21',
          'Couldn’t move this project to {{spaceName}}. Try again.',
          { spaceName: conflict.targetSpace.name }
        )
      )
      setIsResolving(false)
      return
    }
    toast.success(
      translate(
        'auto.components.sidebar.useAddRepoSpaceConflict.7642a01650',
        'Project moved to {{spaceName}}',
        { spaceName: conflict.targetSpace.name }
      ),
      { description: conflict.repo.displayName }
    )
    await conflict.finish()
  }, [conflict, isResolving])

  const openSourceSpace = useCallback(async (): Promise<void> => {
    if (!conflict || isResolving) {
      return
    }
    useAppStore.getState().setActiveSpace(conflict.sourceSpace.id)
    await conflict.finish()
  }, [conflict, isResolving])

  return {
    completeGitRepoAdd,
    conflictView: conflict
      ? {
          projectName: conflict.repo.displayName,
          sourceSpaceName: conflict.sourceSpace.name,
          targetSpaceName: conflict.targetSpace.name
        }
      : null,
    error,
    isResolving,
    moveToActiveSpace,
    openSourceSpace,
    resetSpaceConflict
  }
}
