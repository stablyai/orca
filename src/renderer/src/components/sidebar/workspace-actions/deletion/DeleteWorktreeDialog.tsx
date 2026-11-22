import React, { useCallback, useMemo, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DeleteWorktreeError } from './DeleteWorktreeError'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/slices/worktrees/listing/use-worktree-catalog'
import './delete-worktree-flow'
import { runWorktreeDeletesInParallel } from './worktree-delete-execution'
import { getWorktreeDeleteErrorToShow } from './worktree-delete-error-display'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'
import { DeleteWorktreeDialogFooter } from './DeleteWorktreeDialogFooter'
import { DeleteWorktreeDialogHeading } from './DeleteWorktreeDialogDescription'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { DeleteWorktreeChangesSummary } from './DeleteWorktreeChangesSummary'
import { useRemovalUnsavedFiles } from './use-removal-unsaved-files'
import { persistDeleteWorktreeConfirmSkipPreference } from './delete-worktree-preference-toast'
import {
  countFolderWorkspaceDeletes,
  getDeleteWorktreeDialogCopy,
  getDeleteWorktreeDialogTitle,
  getDeleteWorktreeLineageDialogDescription,
  isFolderWorkspaceDelete as getIsFolderWorkspaceDelete
} from './delete-worktree-dialog-copy'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { WorktreeRemovalTarget } from '../../../../../../shared/worktree/removal/removal'
import { useDeleteWorktreeStatusHydration } from './use-delete-worktree-status-hydration'
import { useDeleteWorktreeDirtyChanges } from './use-delete-worktree-dirty-changes'
import { useDeleteWorktreeAtRiskLocalFiles } from './use-delete-worktree-at-risk-local-files'
import { useConfirmedWorktreeDeleteTargets } from './use-confirmed-worktree-delete-targets'
import { runLineageDeleteAll } from './delete-worktree-lineage-delete-all'
import { runDialogForceDelete } from './delete-worktree-dialog-force-delete'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import { useSidebarHostScopeOptions } from '../../worktree-list/controls/use-sidebar-host-scope-options'
import { translateHostDisplayLabel } from '../../../../runtime/hosts/display/execution-host-label'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { useDeleteWorktreeDialogTargets } from './use-delete-worktree-dialog-targets'
import { useDetachWorktreeDeleteChildren } from './use-detach-worktree-delete-children'
import { useDeleteWorktreeDialogDismissal } from './use-delete-worktree-dialog-dismissal'

const DeleteWorktreeDialog = React.memo(function DeleteWorktreeDialog() {
  const t = useTranslate()
  useUiLanguageRevision()
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const allWorktrees = useAllWorktrees()
  const repos = useAppStore((s) => s.repos)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const updateSettingsOrThrow = useAppStore((s) => s.updateSettingsOrThrow)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const { hostOptions } = useSidebarHostScopeOptions()
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, translateHostDisplayLabel(host, t)])),
    [hostOptions, t]
  )
  const isOpen = activeModal === 'delete-worktree'
  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const worktreeIds = useMemo(
    () =>
      Array.isArray(modalData.worktreeIds)
        ? modalData.worktreeIds.filter((id): id is string => typeof id === 'string')
        : worktreeId
          ? [worktreeId]
          : [],
    [modalData.worktreeIds, worktreeId]
  )
  const {
    worktreeDeleteIdentities,
    lineageDeleteIdentities,
    lineagePreserveIdentities,
    resolveConfirmedTargets
  } = useConfirmedWorktreeDeleteTargets({
    worktreeIdentityData: modalData.worktreeDeleteIdentities,
    lineageIdentityData: modalData.lineageDeleteIdentities,
    preservationIdentityData: modalData.lineagePreserveIdentities,
    closeModal
  })
  const deleteStateTargets = useMemo(
    () =>
      worktreeDeleteIdentities.length > 0
        ? worktreeDeleteIdentities
        : worktreeIds.map((id) => ({ id, hostId: undefined })),
    [worktreeDeleteIdentities, worktreeIds]
  )
  const onDeleted =
    typeof modalData.onDeleted === 'function'
      ? (modalData.onDeleted as (targets: WorktreeRemovalTarget[]) => void)
      : null
  const forceOnConfirm = modalData.forceOnConfirm !== false
  const { worktree, worktrees } = useDeleteWorktreeDialogTargets({
    allWorktrees,
    worktreeDeleteIdentities,
    worktreeId,
    worktreeIds
  })
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const isBatchDelete = worktreeIds.length > 1
  const isFolderWorkspaceDelete = !isBatchDelete && getIsFolderWorkspaceDelete(repoMap, worktree)
  const deleteCopy = getDeleteWorktreeDialogCopy(
    {
      isBatchDelete,
      worktreeCount: worktrees.length,
      folderWorkspaceDeleteCount: countFolderWorkspaceDeletes(repoMap, worktrees),
      isFolderWorkspaceDelete
    },
    t
  )
  const deleteStateByWorktreeId = useAppStore((s) => s.deleteStateByWorktreeId)
  const lineageDelete = useMemo(
    () =>
      !isBatchDelete && worktree
        ? getWorkspaceDeleteLineage(worktree, allWorktrees, worktreeLineageById)
        : { descendants: [], directChildren: [], deleteAllTargets: [] },
    [allWorktrees, isBatchDelete, worktree, worktreeLineageById]
  )
  // Git cannot remove the original clone with worktree remove; block it before the force-delete dead end.
  const isMainWorktree = !isBatchDelete && (worktree?.isMainWorktree ?? false)
  const childWorkspaceCount = lineageDelete.descendants.length
  const {
    preserveChildrenSelected,
    setPreserveChildren,
    isDetachingChildren,
    detachError,
    canPreserveChildren,
    detachChildren
  } = useDetachWorktreeDeleteChildren({
    isOpen,
    parent: worktree,
    lineage: lineageDelete,
    isFolderWorkspace: isFolderWorkspaceDelete,
    confirmedIdentities: lineagePreserveIdentities,
    resolveConfirmedTargets
  })
  const canDeleteAllLineage =
    !isMainWorktree && !isBatchDelete && lineageDelete.deleteAllTargets.length > 1
  const deleteAllLineage = canDeleteAllLineage && !preserveChildrenSelected
  const lineageFolderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, lineageDelete.deleteAllTargets),
    [lineageDelete.deleteAllTargets, repoMap]
  )
  const lineageDeleteDescription = getDeleteWorktreeLineageDialogDescription(
    {
      childWorkspaceCount,
      deleteTargetCount: lineageDelete.deleteAllTargets.length,
      folderWorkspaceDeleteCount: lineageFolderWorkspaceDeleteCount
    },
    t
  )
  const allowSkipConfirm =
    !isBatchDelete &&
    modalData.allowSkipConfirm !== false &&
    childWorkspaceCount === 0 &&
    !preserveChildrenSelected
  const [isSavingForcePreference, setIsSavingForcePreference] = useState(false)
  const deleteTargets = useMemo(
    () => (deleteAllLineage ? lineageDelete.deleteAllTargets : worktrees),
    [deleteAllLineage, lineageDelete.deleteAllTargets, worktrees]
  )
  const deleteStates = useMemo(
    () =>
      deleteTargets
        .map((target) => getDeleteStateForWorktreeHost(target, deleteStateByWorktreeId))
        .filter((state): state is NonNullable<typeof state> => state != null),
    [deleteStateByWorktreeId, deleteTargets]
  )
  const deleteState = worktree
    ? getDeleteStateForWorktreeHost(worktree, deleteStateByWorktreeId)
    : undefined
  const isDeleting = isDetachingChildren || deleteStates.some((state) => state.isDeleting)
  const unsavedTargets = useMemo(
    () => deleteTargets.map(({ id, hostId }) => ({ id, hostId })),
    [deleteTargets]
  )
  const unsavedFiles = useRemovalUnsavedFiles(unsavedTargets, isOpen)
  const deleteError = !isBatchDelete ? getWorktreeDeleteErrorToShow(worktree, deleteState, t) : null
  const canForceDelete = !isBatchDelete && (deleteState?.canForceDelete ?? false)
  const gitStatusByWorktreeIdentity = useDeleteWorktreeStatusHydration({
    isOpen,
    deleteTargets,
    visibleTargets: worktrees,
    repoMap
  })
  const atRiskLocalFilesByIdentity = useDeleteWorktreeAtRiskLocalFiles({
    isOpen,
    deleteTargets,
    repoMap
  })
  const dirtyChanges = useDeleteWorktreeDirtyChanges({
    deleteTargets,
    gitStatusByWorktreeIdentity,
    deleteStateByWorktreeId,
    repoMap
  })

  const handleOpenChange = useDeleteWorktreeDialogDismissal({
    isOpen,
    isDeleting,
    isSaving: isSavingForcePreference || isDetachingChildren,
    isBatchDelete,
    worktreeId,
    worktreeCount: worktrees.length,
    deleteStateTargets,
    clearWorktreeDeleteState,
    closeModal
  })

  const persistSkipConfirmPreference = useCallback(
    (): Promise<void> =>
      persistDeleteWorktreeConfirmSkipPreference({
        updateSettingsOrThrow,
        openSettingsPage,
        openSettingsTarget
      }),
    [openSettingsPage, openSettingsTarget, updateSettingsOrThrow]
  )

  const handleForceDeletedFromToast = useCallback(
    (deletedTarget: WorktreeRemovalTarget): void => onDeleted?.([deletedTarget]),
    [onDeleted]
  )

  const handleDelete = useCallback(
    (force = false) => {
      if (worktreeIds.length === 0) {
        return
      }
      const currentWorktrees = resolveConfirmedTargets(worktreeDeleteIdentities, worktreeIds.length)
      if (!currentWorktrees) {
        return
      }
      const confirmedDiscards = confirmUnsavedDiscard(useAppStore.getState, unsavedTargets)
      if (force) {
        runDialogForceDelete({
          worktreeId,
          currentWorktrees,
          removeWorktree,
          closeModal,
          onDeleted,
          confirmedDiscards
        })
      } else {
        // This modal already confirms destructive removal; dirty files must not require a second Force Delete confirmation.
        const deletePromise = runWorktreeDeletesInParallel(currentWorktrees, {
          force: forceOnConfirm,
          onForceDeleted: handleForceDeletedFromToast,
          confirmedDiscards
        })
        // The workspace card owns progress feedback; close this confirmation when deletion starts.
        closeModal()
        void deletePromise.then((deletedTargets) => {
          if (deletedTargets.length > 0) {
            onDeleted?.(deletedTargets)
          }
        })
      }
    },
    [
      closeModal,
      handleForceDeletedFromToast,
      forceOnConfirm,
      onDeleted,
      removeWorktree,
      worktreeIds.length,
      worktreeDeleteIdentities,
      worktreeId,
      resolveConfirmedTargets,
      unsavedTargets
    ]
  )

  const handleDeleteAll = (): void => {
    runLineageDeleteAll({
      deleteAllTargetCount: lineageDelete.deleteAllTargets.length,
      lineageDeleteIdentities,
      resolveConfirmedTargets,
      forceOnConfirm,
      onForceDeleted: handleForceDeletedFromToast,
      closeModal,
      onDeleted,
      confirmedDiscards: confirmUnsavedDiscard(useAppStore.getState, unsavedTargets)
    })
  }

  const handleDetachAndDelete = (): void => {
    void detachChildren(() => handleDelete(canForceDelete))
  }

  const title = getDeleteWorktreeDialogTitle(
    {
      isBatchDelete,
      deleteAllLineage,
      name: worktree?.displayName ?? '',
      worktreeCount: worktrees.length,
      childWorkspaceCount
    },
    t
  )
  const errorToShow = isMainWorktree ? null : (detachError ?? deleteError)
  const hasTargetList = isBatchDelete || childWorkspaceCount > 0

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        size={hasTargetList ? 'list' : 'confirm'}
        surface="security"
        scrollable
        busy={isDeleting || isSavingForcePreference || isDetachingChildren}
        initialFocus="cancel"
      >
        <DeleteWorktreeDialogHeading
          title={title}
          worktree={worktree}
          hostLabelById={hostLabelById}
          mainWorktreeBlocker={isMainWorktree ? deleteCopy.mainWorktreeBlocker : null}
          targetClassName={deleteCopy.targetClassName}
          targetName={isBatchDelete ? undefined : worktree?.displayName}
          description={deleteAllLineage ? lineageDeleteDescription : deleteCopy.description}
        />

        {isMainWorktree ? null : (
          <div
            className={
              hasTargetList
                ? 'scrollbar-sleek flex h-48 max-h-[50vh] min-w-0 flex-col gap-3 overflow-y-auto *:shrink-0'
                : 'scrollbar-sleek flex h-5 min-w-0 flex-col empty:hidden has-[button[aria-expanded=true]]:h-auto has-[button[aria-expanded=true]]:max-h-[50vh] has-[button[aria-expanded=true]]:overflow-y-auto'
            }
          >
            {isBatchDelete ? (
              <DeleteWorktreeTargetPreview
                isBatchDelete
                unsavedFileCount={unsavedFiles.length}
                worktree={worktree}
                worktrees={worktrees}
                collisionWorktrees={allWorktrees}
                hostLabelById={hostLabelById}
                deleteStateByWorktreeId={deleteStateByWorktreeId}
                changeCheckStatesByWorktreeId={dirtyChanges.checkStates}
                dirtyChangeCountsByWorktreeId={dirtyChanges.counts}
                dirtyChangePreviewsByWorktreeId={dirtyChanges.previews}
                atRiskLocalFilesByIdentity={atRiskLocalFilesByIdentity}
              />
            ) : worktree ? (
              <DeleteWorktreeChangesSummary
                worktree={worktree}
                dirtyChanges={dirtyChanges}
                unsavedFiles={unsavedFiles}
                atRiskLocalFilesByIdentity={atRiskLocalFilesByIdentity}
                showRoutineCheckStatus={hasTargetList}
              />
            ) : null}

            {(childWorkspaceCount > 0 || preserveChildrenSelected) && (
              <DeleteWorktreeLineageNotice
                descendants={lineageDelete.descendants}
                parent={worktree}
                repoMap={repoMap}
                changeCheckStatesByWorktreeId={dirtyChanges.checkStates}
                dirtyChangeCountsByWorktreeId={dirtyChanges.counts}
                dirtyChangePreviewsByWorktreeId={dirtyChanges.previews}
                atRiskLocalFilesByIdentity={atRiskLocalFilesByIdentity}
                preserveChildren={preserveChildrenSelected}
                canPreserveChildren={canPreserveChildren}
                disabled={isDeleting || isSavingForcePreference}
                onPreserveChildrenChange={setPreserveChildren}
              />
            )}
          </div>
        )}

        {errorToShow ? (
          <DeleteWorktreeError
            message={errorToShow}
            canForceDelete={canForceDelete && !detachError}
          />
        ) : null}

        <DeleteWorktreeDialogFooter
          isMainWorktree={isMainWorktree}
          isDeleting={isDeleting || isSavingForcePreference}
          isDetachingChildren={isDetachingChildren}
          deleteDisabled={preserveChildrenSelected && !canPreserveChildren}
          canForceDelete={canForceDelete}
          onForceDelete={
            preserveChildrenSelected ? handleDetachAndDelete : () => handleDelete(true)
          }
          onSavingChange={setIsSavingForcePreference}
          onDelete={
            preserveChildrenSelected
              ? handleDetachAndDelete
              : canDeleteAllLineage
                ? handleDeleteAll
                : () => handleDelete(false)
          }
          onAlwaysDelete={allowSkipConfirm ? persistSkipConfirmPreference : undefined}
        />
      </DialogContent>
    </Dialog>
  )
})

export default DeleteWorktreeDialog
