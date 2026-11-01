import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { runWorktreeDeletesInParallel } from './delete-worktree-flow'
import { getWorktreeDeleteErrorToShow } from './worktree-delete-error-display'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'
import { DeleteWorktreeSkipConfirmOption } from './DeleteWorktreeSkipConfirmOption'
import { DeleteWorktreeDialogFooter } from './DeleteWorktreeDialogFooter'
import { DeleteWorktreeDialogDescription } from './DeleteWorktreeDialogDescription'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { DeleteWorktreeWarningPanels } from './DeleteWorktreeWarningPanels'
import { persistDeleteWorktreeConfirmSkipPreference } from './delete-worktree-preference-toast'
import {
  getDeleteWorktreeChangeCheckStates,
  getDeleteWorktreeDirtyChangeCounts,
  getDeleteWorktreeDirtyChangePreviews
} from './delete-worktree-dirty-change-counts'
import {
  countFolderWorkspaceDeletes,
  getDeleteWorktreeDialogCopy,
  getDeleteWorktreeLineageDialogDescription,
  isFolderWorkspaceDelete as getIsFolderWorkspaceDelete
} from './delete-worktree-dialog-copy'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { useDeleteWorktreeStatusHydration } from './use-delete-worktree-status-hydration'
import { useConfirmedWorktreeDeleteTargets } from './use-confirmed-worktree-delete-targets'
import { runLineageDeleteAll } from './delete-worktree-lineage-delete-all'
import { runDialogForceDelete } from './delete-worktree-dialog-force-delete'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { RemovalUnsavedFilesNotice } from './RemovalUnsavedFilesNotice'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { useDeleteWorktreeDialogTargets } from './use-delete-worktree-dialog-targets'
import { collectRemovalUnsavedFiles } from '@/components/editor/removal-unsaved-editor-files'

const DeleteWorktreeDialog = React.memo(function DeleteWorktreeDialog() {
  useUiLanguageRevision()
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const allWorktrees = useAllWorktrees()
  const repos = useAppStore((s) => s.repos)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const { hostOptions } = useSidebarHostScopeOptions()
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
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
  const { worktreeDeleteIdentities, lineageDeleteIdentities, resolveConfirmedTargets } =
    useConfirmedWorktreeDeleteTargets({
      worktreeIdentityData: modalData.worktreeDeleteIdentities,
      lineageIdentityData: modalData.lineageDeleteIdentities,
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
  const deleteCopy = getDeleteWorktreeDialogCopy({
    isBatchDelete,
    worktreeCount: worktrees.length,
    folderWorkspaceDeleteCount: countFolderWorkspaceDeletes(repoMap, worktrees),
    isFolderWorkspaceDelete
  })
  const deleteStateByWorktreeId = useAppStore((s) => s.deleteStateByWorktreeId)
  const lineageDelete = useMemo(
    () =>
      !isBatchDelete && worktree
        ? getWorkspaceDeleteLineage(worktree, allWorktrees, worktreeLineageById)
        : { descendants: [], deleteAllTargets: [] },
    [allWorktrees, isBatchDelete, worktree, worktreeLineageById]
  )
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  // Git cannot remove the original clone with worktree remove; block it before the force-delete dead end.
  const isMainWorktree = !isBatchDelete && (worktree?.isMainWorktree ?? false)
  const childWorkspaceCount = lineageDelete.descendants.length
  const canDeleteAllLineage =
    !isMainWorktree && !isBatchDelete && lineageDelete.deleteAllTargets.length > 1
  const lineageFolderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, lineageDelete.deleteAllTargets),
    [lineageDelete.deleteAllTargets, repoMap]
  )
  const lineageDeleteDescription = getDeleteWorktreeLineageDialogDescription({
    childWorkspaceCount,
    deleteTargetCount: lineageDelete.deleteAllTargets.length,
    folderWorkspaceDeleteCount: lineageFolderWorkspaceDeleteCount
  })
  const allowSkipConfirm =
    !isBatchDelete && modalData.allowSkipConfirm !== false && childWorkspaceCount === 0
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [isSavingForcePreference, setIsSavingForcePreference] = useState(false)
  const deleteTargets = useMemo(
    () => (canDeleteAllLineage ? lineageDelete.deleteAllTargets : worktrees),
    [canDeleteAllLineage, lineageDelete.deleteAllTargets, worktrees]
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
  const isDeleting = deleteStates.some((state) => state.isDeleting)
  const unsavedTargets = useMemo(
    () => deleteTargets.map(({ id, hostId }) => ({ id, hostId })),
    [deleteTargets]
  )
  const deleteError = !isBatchDelete ? getWorktreeDeleteErrorToShow(worktree, deleteState) : null
  const canForceDelete = !isBatchDelete && (deleteState?.canForceDelete ?? false)
  const gitStatusByWorktreeIdentity = useDeleteWorktreeStatusHydration({
    isOpen,
    deleteTargets,
    visibleTargets: worktrees,
    repoMap
  })
  const dirtyChanges = useMemo(() => {
    const statusInput = { deleteTargets, gitStatusByWorktree, gitStatusByWorktreeIdentity, repoMap }
    return {
      checkStates: getDeleteWorktreeChangeCheckStates(statusInput),
      counts: getDeleteWorktreeDirtyChangeCounts({ ...statusInput, deleteStateByWorktreeId }),
      previews: getDeleteWorktreeDirtyChangePreviews(statusInput)
    }
  }, [
    deleteStateByWorktreeId,
    deleteTargets,
    gitStatusByWorktree,
    gitStatusByWorktreeIdentity,
    repoMap
  ])

  if (!isOpen && dontAskAgain) {
    // Do not carry a canceled one-shot checkbox into later deletions.
    setDontAskAgain(false)
  }

  useEffect(() => {
    if (isOpen && worktreeIds.length > 0 && worktrees.length === 0 && !isDeleting) {
      for (const target of deleteStateTargets) {
        clearWorktreeDeleteState(target.id, target.hostId)
      }
      closeModal()
    }
  }, [
    clearWorktreeDeleteState,
    closeModal,
    deleteStateTargets,
    isDeleting,
    isOpen,
    worktreeIds,
    worktreeIds.length,
    worktrees.length
  ])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open || isSavingForcePreference) {
        return
      }
      const state = useAppStore.getState().deleteStateByWorktreeId
      const currentTarget = deleteStateTargets.find((target) => target.id === worktreeId)
      const currentState = currentTarget
        ? getDeleteStateForWorktreeHost(currentTarget, state)
        : undefined
      if (isBatchDelete) {
        for (const target of deleteStateTargets) {
          if (!getDeleteStateForWorktreeHost(target, state)?.isDeleting) {
            clearWorktreeDeleteState(target.id, target.hostId)
          }
        }
      } else if (worktreeId && !currentState?.isDeleting) {
        clearWorktreeDeleteState(worktreeId, currentTarget?.hostId)
      }
      closeModal()
    },
    [
      clearWorktreeDeleteState,
      closeModal,
      deleteStateTargets,
      isBatchDelete,
      isSavingForcePreference,
      worktreeId
    ]
  )

  const persistDontAskAgainPreference = useCallback((): void => {
    persistDeleteWorktreeConfirmSkipPreference({
      updateSettings,
      openSettingsPage,
      openSettingsTarget
    })
  }, [openSettingsPage, openSettingsTarget, updateSettings])

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
      // Force delete is recovery, not consent to skip future confirmations; persist that preference only on primary confirmation.
      if (dontAskAgain && allowSkipConfirm && !force) {
        persistDontAskAgainPreference()
      }
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
      dontAskAgain,
      allowSkipConfirm,
      handleForceDeletedFromToast,
      forceOnConfirm,
      onDeleted,
      persistDontAskAgainPreference,
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

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        surface="security"
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          // Unsaved edits must not be discarded by Enter; retain Radix’s default focus.
          if (
            isMainWorktree ||
            collectRemovalUnsavedFiles(useAppStore.getState, unsavedTargets).length > 0
          ) {
            return
          }
          event.preventDefault()
          // Focus confirmation for the chosen destructive action so Delete, Enter works without landing on Cancel.
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isBatchDelete
              ? translate(
                  'auto.components.sidebar.DeleteWorktreeDialog.86f0ae1257',
                  'Delete Workspaces'
                )
              : translate(
                  'auto.components.sidebar.DeleteWorktreeDialog.fc23c4cbdf',
                  'Delete Workspace'
                )}
          </DialogTitle>
          <DeleteWorktreeDialogDescription
            showChangeLossWarning={dirtyChanges.checkStates.size > 0}
            targetClassName={deleteCopy.targetClassName}
            targetName={isBatchDelete ? undefined : worktree?.displayName}
            description={canDeleteAllLineage ? lineageDeleteDescription : deleteCopy.description}
          />
        </DialogHeader>

        <div className="scrollbar-sleek max-h-[50vh] min-w-0 space-y-4 overflow-y-auto">
          <DeleteWorktreeTargetPreview
            isBatchDelete={isBatchDelete}
            worktree={worktree}
            worktrees={worktrees}
            collisionWorktrees={allWorktrees}
            hostLabelById={hostLabelById}
            deleteStateByWorktreeId={deleteStateByWorktreeId}
            changeCheckStatesByWorktreeId={dirtyChanges.checkStates}
            dirtyChangeCountsByWorktreeId={dirtyChanges.counts}
            dirtyChangePreviewsByWorktreeId={dirtyChanges.previews}
          />

          <RemovalUnsavedFilesNotice targets={unsavedTargets} enabled={isOpen} />

          {childWorkspaceCount > 0 && (
            <DeleteWorktreeLineageNotice
              descendants={lineageDelete.descendants}
              parent={worktree}
              repoMap={repoMap}
              changeCheckStatesByWorktreeId={dirtyChanges.checkStates}
              dirtyChangeCountsByWorktreeId={dirtyChanges.counts}
              dirtyChangePreviewsByWorktreeId={dirtyChanges.previews}
            />
          )}
        </div>

        <DeleteWorktreeWarningPanels
          isMainWorktree={isMainWorktree}
          mainWorktreeBlocker={deleteCopy.mainWorktreeBlocker}
          deleteError={deleteError}
        />

        <DeleteWorktreeSkipConfirmOption
          showDontAskAgain={!isMainWorktree && allowSkipConfirm && !canForceDelete}
          dontAskAgain={dontAskAgain}
          onToggleDontAskAgain={() => setDontAskAgain((prev) => !prev)}
        />

        <DialogFooter>
          <DeleteWorktreeDialogFooter
            isMainWorktree={isMainWorktree}
            isDeleting={isDeleting || isSavingForcePreference}
            canForceDelete={canForceDelete}
            isBatchDelete={isBatchDelete}
            worktreeCount={worktrees.length}
            canDeleteAllLineage={canDeleteAllLineage}
            lineageDeleteTargetCount={lineageDelete.deleteAllTargets.length}
            onCancel={() => handleOpenChange(false)}
            onForceDelete={() => handleDelete(true)}
            onSavingChange={setIsSavingForcePreference}
            onDelete={canDeleteAllLineage ? handleDeleteAll : () => handleDelete(false)}
            confirmButtonRef={confirmButtonRef}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default DeleteWorktreeDialog
