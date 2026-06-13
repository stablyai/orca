import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { runWorktreeDeletesInParallel } from './delete-worktree-flow'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'
import { DeleteWorktreeSkipConfirmOption } from './DeleteWorktreeSkipConfirmOption'
import { DeleteWorktreeDialogFooter } from './DeleteWorktreeDialogFooter'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { DeleteWorktreeWarningPanels } from './DeleteWorktreeWarningPanels'
import {
  countFolderWorkspaceDeletes,
  getDeleteWorktreeDialogCopy,
  getDeleteWorktreeLineageDialogCopy,
  isFolderWorkspaceDelete as getIsFolderWorkspaceDelete
} from './delete-worktree-dialog-copy'
import { translate } from '@/i18n/i18n'

const DeleteWorktreeDialog = React.memo(function DeleteWorktreeDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const allWorktrees = useAppStore((s) => s.allWorktrees)
  const repos = useAppStore((s) => s.repos)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const settings = useAppStore((s) => s.settings)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const setGitStatus = useAppStore((s) => s.setGitStatus)

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
  const onDeleted =
    typeof modalData.onDeleted === 'function'
      ? (modalData.onDeleted as (worktreeIds: string[]) => void)
      : null
  const worktree = useMemo(
    () => (worktreeId ? (allWorktrees().find((item) => item.id === worktreeId) ?? null) : null),
    [allWorktrees, worktreeId]
  )
  const worktrees = useMemo(() => {
    if (worktreeIds.length === 0) {
      return []
    }
    const selected = new Set(worktreeIds)
    return allWorktrees().filter((item) => selected.has(item.id))
  }, [allWorktrees, worktreeIds])
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const isBatchDelete = worktreeIds.length > 1
  const isFolderWorkspaceDelete = !isBatchDelete && getIsFolderWorkspaceDelete(repoMap, worktree)
  const folderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, worktrees),
    [repoMap, worktrees]
  )
  const deleteCopy = getDeleteWorktreeDialogCopy({
    isBatchDelete,
    worktree,
    worktreeCount: worktrees.length,
    folderWorkspaceDeleteCount,
    isFolderWorkspaceDelete
  })
  const deleteStateByWorktreeId = useAppStore((s) => s.deleteStateByWorktreeId)
  const lineageDelete = useMemo(
    () =>
      !isBatchDelete && worktree
        ? getWorkspaceDeleteLineage(worktree, allWorktrees(), worktreeLineageById)
        : { descendants: [], deleteAllTargets: [] },
    [allWorktrees, isBatchDelete, worktree, worktreeLineageById]
  )
  const deleteStateIds = useMemo(
    () =>
      Array.from(
        new Set([...worktreeIds, ...lineageDelete.deleteAllTargets.map((target) => target.id)])
      ),
    [lineageDelete.deleteAllTargets, worktreeIds]
  )
  const deleteStates = useMemo(
    () =>
      deleteStateIds
        .map((id) => deleteStateByWorktreeId[id])
        .filter((state): state is NonNullable<typeof state> => state != null),
    [deleteStateByWorktreeId, deleteStateIds]
  )
  const deleteState = worktreeId ? deleteStateByWorktreeId[worktreeId] : undefined
  const isDeleting = deleteStates.some((state) => state.isDeleting)
  const deleteError = !isBatchDelete ? (deleteState?.error ?? null) : null
  const canForceDelete = !isBatchDelete && (deleteState?.canForceDelete ?? false)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  // Why: the main worktree is the repo's original clone directory — `git worktree remove`
  // always rejects it. We block the delete button upfront so the user doesn't have to
  // discover this limitation via a confusing force-delete dead-end.
  const isMainWorktree = !isBatchDelete && (worktree?.isMainWorktree ?? false)
  const childWorkspaceCount = lineageDelete.descendants.length
  const hasLineageChildren = childWorkspaceCount > 0
  const canDeleteAllLineage =
    !isMainWorktree && !isBatchDelete && lineageDelete.deleteAllTargets.length > 1
  const lineageFolderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, lineageDelete.deleteAllTargets),
    [lineageDelete.deleteAllTargets, repoMap]
  )
  const lineageDeleteCopy = getDeleteWorktreeLineageDialogCopy({
    childWorkspaceCount,
    deleteTargetCount: lineageDelete.deleteAllTargets.length,
    folderWorkspaceDeleteCount: lineageFolderWorkspaceDeleteCount
  })
  const allowSkipConfirm =
    !isBatchDelete && modalData.allowSkipConfirm !== false && childWorkspaceCount === 0
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const deleteTargets = useMemo(
    () => (canDeleteAllLineage ? lineageDelete.deleteAllTargets : worktrees),
    [canDeleteAllLineage, lineageDelete.deleteAllTargets, worktrees]
  )
  const dirtyChangeCountsByWorktreeId = useMemo(() => {
    const result = new Map<string, number>()
    for (const item of deleteTargets) {
      if (item.isMainWorktree || getIsFolderWorkspaceDelete(repoMap, item)) {
        continue
      }
      const statusEntries = gitStatusByWorktree[item.id]
      if ((statusEntries?.length ?? 0) > 0) {
        result.set(item.id, statusEntries?.length ?? 0)
      } else if (deleteStateByWorktreeId[item.id]?.canForceDelete) {
        result.set(item.id, 0)
      }
    }
    return result
  }, [deleteStateByWorktreeId, deleteTargets, gitStatusByWorktree, repoMap])

  if (!isOpen && dontAskAgain) {
    // Why: this checkbox is a one-shot dialog intent; reset it as soon as the
    // dialog is closed so a later delete never inherits a cancelled choice.
    setDontAskAgain(false)
  }

  useEffect(() => {
    if (isOpen && worktreeIds.length > 0 && worktrees.length === 0 && !isDeleting) {
      for (const id of worktreeIds) {
        clearWorktreeDeleteState(id)
      }
      closeModal()
    }
  }, [
    clearWorktreeDeleteState,
    closeModal,
    isDeleting,
    isOpen,
    worktreeIds,
    worktreeIds.length,
    worktrees.length
  ])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    const statusTargets = deleteTargets.filter(
      (item) =>
        !item.isMainWorktree &&
        !getIsFolderWorkspaceDelete(repoMap, item) &&
        gitStatusByWorktree[item.id] === undefined
    )
    if (statusTargets.length === 0) {
      return
    }
    let cancelled = false
    for (const item of statusTargets) {
      void getRuntimeGitStatus({
        settings,
        worktreeId: item.id,
        worktreePath: item.path,
        connectionId: getConnectionId(item.id) ?? undefined
      })
        .then((status) => {
          if (!cancelled) {
            setGitStatus(item.id, status)
          }
        })
        .catch(() => {
          // Best-effort only: delete itself still performs the authoritative
          // backend check and will surface failures through the normal toast.
        })
    }
    return () => {
      cancelled = true
    }
  }, [deleteTargets, gitStatusByWorktree, isOpen, repoMap, setGitStatus, settings])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }
      const currentState = worktreeId
        ? useAppStore.getState().deleteStateByWorktreeId[worktreeId]
        : undefined
      if (isBatchDelete) {
        const state = useAppStore.getState().deleteStateByWorktreeId
        for (const id of worktreeIds) {
          if (!state[id]?.isDeleting) {
            clearWorktreeDeleteState(id)
          }
        }
      } else if (worktreeId && !currentState?.isDeleting) {
        clearWorktreeDeleteState(worktreeId)
      }
      closeModal()
    },
    [clearWorktreeDeleteState, closeModal, isBatchDelete, worktreeId, worktreeIds]
  )

  const persistDontAskAgainPreference = useCallback((): void => {
    void updateSettings({ skipDeleteWorktreeConfirm: true })
    // Why: the toast confirms the preference was saved and points the user at
    // where to undo it. The "Open Settings" action deep-links to the General
    // pane so they never have to hunt for the toggle if they change their mind.
    toast.success(translate("auto.components.sidebar.DeleteWorktreeDialog.dd3a45bbbd", "We'll skip this confirmation next time."), {
      description: translate("auto.components.sidebar.DeleteWorktreeDialog.2b56b35f53", "You can change this in Settings."),
      duration: 8000,
      action: {
        label: translate("auto.components.sidebar.DeleteWorktreeDialog.5cc1a6701c", "Open Settings"),
        onClick: () => {
          openSettingsPage()
          openSettingsTarget({
            pane: 'general',
            repoId: null,
            sectionId: 'general-skip-delete-worktree-confirm'
          })
        }
      }
    })
  }, [openSettingsPage, openSettingsTarget, updateSettings])

  const handleForceDeletedFromToast = useCallback(
    (deletedId: string): void => {
      onDeleted?.([deletedId])
    },
    [onDeleted]
  )

  const handleDelete = useCallback(
    (force = false) => {
      if (worktreeIds.length === 0) {
        return
      }
      // Why: force-delete is a recovery path taken after a failed first delete.
      // Saving "don't ask again" from that state would conflate the recovery
      // action with a broader preference. Only persist the preference on the
      // primary (non-force) confirmation so users intentionally opt in.
      if (dontAskAgain && allowSkipConfirm && !force) {
        persistDontAskAgainPreference()
      }
      if (force) {
        // Why: this branch preserves the legacy "Force Delete" button behavior
        // inside the dialog — it runs the destructive retry directly without
        // the shared toast wrapper. Close immediately because workspace cards
        // already show the deleting state while the retry runs.
        const deletePromise = removeWorktree(worktreeId, true)
        closeModal()
        deletePromise
          .then((result) => {
            if (!result.ok) {
              toast.error(translate("auto.components.sidebar.DeleteWorktreeDialog.42e610d6cf", "Force delete failed"), {
                description: result.error
              })
              return
            }
            onDeleted?.([worktreeId])
          })
          .catch((err: unknown) => {
            toast.error(translate("auto.components.sidebar.DeleteWorktreeDialog.4f6750ca7b", "Failed to delete workspace"), {
              description: err instanceof Error ? err.message : String(err)
            })
          })
      } else {
        // Why: this modal is the destructive confirmation for the workspace
        // folder. Running a non-force remove here just turns dirty files into
        // a redundant Force Delete toast after the user already confirmed.
        const deletePromise = runWorktreeDeletesInParallel(worktrees, {
          force: true,
          onForceDeleted: handleForceDeletedFromToast
        })
        // Why: the workspace card owns the in-progress feedback, so the
        // confirmation should get out of the way as soon as deletion begins.
        closeModal()
        void deletePromise.then((deletedIds) => {
          if (deletedIds.length > 0) {
            onDeleted?.(deletedIds)
          }
        })
      }
    },
    [
      closeModal,
      dontAskAgain,
      allowSkipConfirm,
      handleForceDeletedFromToast,
      onDeleted,
      persistDontAskAgainPreference,
      removeWorktree,
      worktreeIds.length,
      worktreeId,
      worktrees
    ]
  )

  const handleDeleteAll = useCallback(() => {
    if (lineageDelete.deleteAllTargets.length <= 1) {
      return
    }
    // Why: the lineage modal confirms every affected workspace up front, so
    // dirty child workspaces should not create per-workspace force prompts.
    const deletePromise = runWorktreeDeletesInParallel(lineageDelete.deleteAllTargets, {
      force: true,
      onForceDeleted: handleForceDeletedFromToast
    })
    // Why: deletion progress is shown on the workspace cards; the modal should
    // not sit on top of that in-progress UI.
    closeModal()
    void deletePromise.then((deletedIds) => {
      if (deletedIds.length > 0) {
        onDeleted?.(deletedIds)
      }
    })
  }, [closeModal, handleForceDeletedFromToast, lineageDelete.deleteAllTargets, onDeleted])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          if (isMainWorktree) {
            return
          }
          event.preventDefault()
          // Why: this confirmation dialog exists specifically to guard a
          // destructive action the user already chose from the context menu.
          // Radix otherwise picks the first tabbable control, which can be the
          // cancel/close affordance and breaks the expected "Delete, Enter"
          // flow for quick keyboard confirmation.
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isBatchDelete ? translate("auto.components.sidebar.DeleteWorktreeDialog.86f0ae1257", "Delete Workspaces") : translate("auto.components.sidebar.DeleteWorktreeDialog.fc23c4cbdf", "Delete Workspace")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate("auto.components.sidebar.DeleteWorktreeDialog.91492c9ad6", "Remove")}<span className={deleteCopy.targetClassName}>{deleteCopy.targetLabel}</span>
            {canDeleteAllLineage ? (
              <>
                {' '}
                {translate("auto.components.sidebar.DeleteWorktreeDialog.ff2a74ac0e", "and")}{' '}
                <span className="font-medium text-foreground">
                  {lineageDeleteCopy.childTargetLabel}
                </span>{' '}
                {lineageDeleteCopy.descriptionSuffix}
              </>
            ) : (
              <> {deleteCopy.descriptionSuffix}</>
            )}
          </DialogDescription>
        </DialogHeader>

        <DeleteWorktreeTargetPreview
          isBatchDelete={isBatchDelete}
          worktree={worktree}
          worktrees={worktrees}
          deleteStateByWorktreeId={deleteStateByWorktreeId}
          dirtyChangeCountsByWorktreeId={dirtyChangeCountsByWorktreeId}
        />

        {hasLineageChildren && (
          <DeleteWorktreeLineageNotice
            descendants={lineageDelete.descendants}
            dirtyChangeCountsByWorktreeId={dirtyChangeCountsByWorktreeId}
          />
        )}

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
            isDeleting={isDeleting}
            canForceDelete={canForceDelete}
            isBatchDelete={isBatchDelete}
            worktreeCount={worktrees.length}
            canDeleteAllLineage={canDeleteAllLineage}
            lineageDeleteTargetCount={lineageDelete.deleteAllTargets.length}
            onCancel={() => handleOpenChange(false)}
            onForceDelete={() => handleDelete(true)}
            onDelete={canDeleteAllLineage ? handleDeleteAll : () => handleDelete(false)}
            confirmButtonRef={confirmButtonRef}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default DeleteWorktreeDialog
