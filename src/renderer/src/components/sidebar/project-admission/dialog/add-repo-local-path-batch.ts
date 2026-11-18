import { useEffect, type RefObject } from 'react'
import { toast } from 'sonner'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import type { AddRepoExistingWorkspaceSource } from '../../../../../../shared/telemetry/schemas/telemetry-property-schemas'
import type { CompleteGitRepoAdd } from '../completion/use-complete-git-repo-add'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WslMoveRowRef } from '../../../../../../shared/wsl-move/wsl-move-driver-types'
import { showSkippedBatchFoldersToast } from '../completion/add-repo-skipped-folders-toast'
import { worktreeRefreshOptions } from '../host-selection/add-repo-runtime-owner'

/** What a paused add added; `imported` lists every repo a nested import added, `repo` included. */
export type PausedLocalPathAdd = { repo: Repo; imported?: readonly WslMoveRowRef[] }

export type LocalPathAddResult =
  | { status: 'completed'; repo: Repo; selectedPath: string }
  | {
      status: 'paused'
      /** Set when the add waits on "Open as Folder" or nested review: the project it added, or null. */
      projectAdded?: Promise<PausedLocalPathAdd | null>
    }
  | { status: 'cancelled' | 'skipped' | 'failed' }

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
  onGitRepoReady: CompleteGitRepoAdd
}): Promise<LocalPathBatchOutcome> {
  let firstGitRepo: { id: string; selectedPath: string } | undefined
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
    if (!firstGitRepo && isGitRepoKind(result.repo)) {
      firstGitRepo = { id: result.repo.id, selectedPath: result.selectedPath }
    }
  }
  if (!isCurrentGen()) {
    return 'cancelled'
  }
  if (skippedCount > 0) {
    showSkippedBatchFoldersToast()
  }
  if (shouldDeferGitRepoReady && firstGitRepo) {
    await onGitRepoReady(
      firstGitRepo.id,
      source,
      worktreeRefreshOptions(activeRuntimeEnvironmentId ?? null).executionHostId,
      { selectedPath: firstGitRepo.selectedPath }
    )
    return 'completed'
  }
  return sawFailure || (shouldDeferGitRepoReady && !firstGitRepo) ? 'unsettled' : 'completed'
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

/** Holds one local path to offer its WSL distro as a host; `isCurrent` turns false on close. */
export type OfferWslHost = (
  path: string,
  source: AddRepoExistingWorkspaceSource,
  isCurrent: () => boolean
) => Promise<boolean>

/** True when the offer held `path`, or the add it answered for was closed meanwhile. */
export async function heldByWslHostOffer(
  offerWslHost: OfferWslHost | undefined,
  path: string,
  isCurrent: () => boolean
): Promise<boolean> {
  return (await offerWslHost?.(path, 'local_folder_picker', isCurrent)) === true || !isCurrent()
}

/** Adds a folder dropped onto the dialog once, unless the WSL host offer holds it. */
export function useDroppedLocalPathAutoAdd({
  isOpen,
  droppedLocalPath,
  droppedLocalPathHandledRef,
  localAddGenRef,
  offerWslHost,
  addPath
}: {
  isOpen: boolean
  droppedLocalPath: string
  droppedLocalPathHandledRef: RefObject<string | null>
  localAddGenRef: RefObject<number>
  offerWslHost?: OfferWslHost
  addPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
}): void {
  useEffect(() => {
    if (!isOpen || !droppedLocalPath || droppedLocalPathHandledRef.current === droppedLocalPath) {
      return
    }
    droppedLocalPathHandledRef.current = droppedLocalPath
    const gen = localAddGenRef.current
    void (async () => {
      const isCurrent = (): boolean => gen === localAddGenRef.current
      if (!(await heldByWslHostOffer(offerWslHost, droppedLocalPath, isCurrent))) {
        await addPath(droppedLocalPath, 'local_folder_picker')
      }
    })()
  }, [addPath, droppedLocalPath, droppedLocalPathHandledRef, isOpen, localAddGenRef, offerWslHost])
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
  offerWslHost?: OfferWslHost
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
    const offerGen = localAddGenRef.current
    void (async () => {
      const isCurrent = (): boolean => offerGen === localAddGenRef.current
      if (
        pickedLocalPaths.length === 1
          ? await heldByWslHostOffer(offerWslHost, pickedLocalPaths[0], isCurrent)
          : !isCurrent()
      ) {
        return
      }
      const gen = ++localAddGenRef.current
      setIsAdding(true)
      await runPickedLocalPathsBatch({
        paths: pickedLocalPaths,
        gen,
        isCurrentGen: () => gen === localAddGenRef.current,
        addPaths,
        onUnsettled,
        onFinally: onFinishAttempt
      })
    })()
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
