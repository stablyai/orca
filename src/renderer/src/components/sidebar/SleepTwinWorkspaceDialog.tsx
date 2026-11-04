import React, { useCallback, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { runSleepWorktrees } from './sleep-worktree-flow'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

const SleepTwinWorkspaceDialog = React.memo(function SleepTwinWorkspaceDialog() {
  useUiLanguageRevision()
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const isOpen = activeModal === 'confirm-sleep-twin'
  const worktreeIds = useMemo(() => readStrings(modalData.worktreeIds), [modalData.worktreeIds])
  const hostIds = useMemo(
    () =>
      readStrings(modalData.hostIds).flatMap((hostId): ExecutionHostId[] => {
        const parsed = parseExecutionHostId(hostId)
        return parsed ? [parsed.id] : []
      }),
    [modalData.hostIds]
  )
  const hostLabels = hostIds
    .map((hostId) => selectExecutionHostDisplayLabel(useAppStore.getState(), hostId))
    .join(', ')

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )
  const handleConfirm = useCallback(() => {
    closeModal()
    void runSleepWorktrees(worktreeIds)
  }, [closeModal, worktreeIds])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.sidebar.SleepTwinWorkspaceDialog.title', 'Sleep Workspace')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.SleepTwinWorkspaceDialog.alsoSleeps',
              'Also sleeps the copy on {{hosts}}',
              { hosts: hostLabels }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.sidebar.SleepTwinWorkspaceDialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleConfirm}>
            {translate('auto.components.sidebar.SleepTwinWorkspaceDialog.confirm', 'Sleep')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default SleepTwinWorkspaceDialog
