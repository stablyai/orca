import { useEffect, type RefObject } from 'react'
import { toast } from 'sonner'
import { isGitRepoKind } from '../../../../../../shared/repo-kind'
import type { AddRepoExistingWorkspaceSource } from '../../../../../../shared/telemetry-events'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import { showSkippedBatchFoldersToast } from '../completion/add-repo-skipped-folders-toast'
import { worktreeRefreshOptions } from '../host-selection/add-repo-runtime-owner'

export type LocalPathAddResult =
  | { status: 'completed'; repo: Repo }
  | { status: 'cancelled' | 'paused' | 'skipped' | 'failed' }

export type LocalPathAddMode = 'single' | 'batch'

export type LocalPathBatchOutcome = 'completed' | 'paused' | 'cancelled' | 'unsettled'

export async function addLocalPathsForGeneration({
  paths,
  source,
  gen,
  isCurrentGen,
  activeRuntimeEnvironmentId,
  addLocalPathForGeneration,
  onGitRepoReady
}: {
  paths: readonly string[]
  source: AddRepoExistingWorkspaceSource
  gen: number
  isCurrentGen: () => boolean
  activeRuntimeEnvironmentId: string | null | undefined
  addLocalPathForGeneration: (
    path: string,
    source: AddRepoExistingWorkspaceSource,
    gen: number,
    mode: LocalPathAddMode
  ) => Promise<LocalPathAddResult>
  onGitRepoReady: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId
  ) => Promise<void>
}): Promise<LocalPathBatchOutcome> {
  const gitRepoIds: string[] = []
  const shouldDeferGitRepoReady = paths.length > 1
  let skippedCount = 0
  let sawFailure = false
  for (const path of paths) {
    const result = await addLocalPathForGeneration(
      path,
      source,
      gen,
      shouldDeferGitRepoReady ? 'batch' : 'single'
    )
    if (result.status === 'skipped') {
      skippedCount++
      continue
    }
    if (result.status === 'failed') {
      sawFailure = true
      break
    }
    if (result.status === 'cancelled') {
      return 'cancelled'
    }
    if (result.status !== 'completed') {
      return 'paused'
    }
    if (isGitRepoKind(result.repo)) {
      gitRepoIds.push(result.repo.id)
    }
  }
  if (!isCurrentGen()) {
    return 'cancelled'
  }
  if (skippedCount > 0) {
    showSkippedBatchFoldersToast()
  }
  if (shouldDeferGitRepoReady && gitRepoIds.length > 0) {
    await onGitRepoReady(
      gitRepoIds[0],
      source,
      worktreeRefreshOptions(activeRuntimeEnvironmentId ?? null).executionHostId
    )
    return 'completed'
  }
  return sawFailure || (shouldDeferGitRepoReady && gitRepoIds.length === 0)
    ? 'unsettled'
    : 'completed'
}

async function runPickedLocalPathsBatch({
  paths,
  gen,
  isCurrentGen,
  addPaths,
  onUnsettled,
  onFinally
}: {
  paths: readonly string[]
  gen: number
  isCurrentGen: () => boolean
  addPaths: (
    paths: readonly string[],
    source: AddRepoExistingWorkspaceSource,
    gen: number
  ) => Promise<LocalPathBatchOutcome>
  onUnsettled?: () => void
  onFinally: () => void
}): Promise<void> {
  try {
    const outcome = await addPaths(paths, 'local_folder_picker', gen)
    if (outcome === 'unsettled' && isCurrentGen()) {
      onUnsettled?.()
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
    if (isCurrentGen()) {
      onUnsettled?.()
    }
  } finally {
    if (isCurrentGen()) {
      onFinally()
    }
  }
}

export function usePickedLocalPathsAutoAdd({
  isOpen,
  pickedLocalPaths,
  pickedLocalPathsHandledRef,
  localAddGenRef,
  offerWslHost,
  addPaths,
  onUnsettled,
  setIsAdding,
  onFinishAttempt
}: {
  isOpen: boolean
  pickedLocalPaths: readonly string[] | null
  pickedLocalPathsHandledRef: RefObject<readonly string[] | null>
  localAddGenRef: RefObject<number>
  offerWslHost?: (path: string, source: AddRepoExistingWorkspaceSource) => boolean
  addPaths: (
    paths: readonly string[],
    source: AddRepoExistingWorkspaceSource,
    gen: number
  ) => Promise<LocalPathBatchOutcome>
  onUnsettled?: () => void
  setIsAdding: (isAdding: boolean) => void
  onFinishAttempt: () => void
}): void {
  useEffect(() => {
    if (!isOpen || !pickedLocalPaths || pickedLocalPaths.length === 0) {
      return
    }
    if (pickedLocalPathsHandledRef.current === pickedLocalPaths) {
      return
    }
    pickedLocalPathsHandledRef.current = pickedLocalPaths
    if (
      pickedLocalPaths.length === 1 &&
      offerWslHost?.(pickedLocalPaths[0], 'local_folder_picker')
    ) {
      return
    }
    const gen = ++localAddGenRef.current
    setIsAdding(true)
    void runPickedLocalPathsBatch({
      paths: pickedLocalPaths,
      gen,
      isCurrentGen: () => gen === localAddGenRef.current,
      addPaths,
      onUnsettled,
      onFinally: onFinishAttempt
    })
  }, [
    addPaths,
    isOpen,
    localAddGenRef,
    offerWslHost,
    onFinishAttempt,
    onUnsettled,
    pickedLocalPaths,
    pickedLocalPathsHandledRef,
    setIsAdding
  ])
}
