import React from 'react'
import { AutomationDeleteDialog, ExternalAutomationDeleteDialog } from './AutomationDeleteDialogs'

type Props = {
  deleteTarget: React.ComponentProps<typeof AutomationDeleteDialog>['deleteTarget']
  dontAskDeleteAgain: boolean
  deleteConfirmButtonRef: React.ComponentProps<typeof AutomationDeleteDialog>['confirmButtonRef']
  setDeleteTarget: (target: null) => void
  setDontAskDeleteAgain: (value: boolean) => void
  confirmDeleteAutomation: () => void
  externalDeleteTarget: React.ComponentProps<
    typeof ExternalAutomationDeleteDialog
  >['externalDeleteTarget']
  externalDeleteConfirmButtonRef: React.ComponentProps<
    typeof ExternalAutomationDeleteDialog
  >['confirmButtonRef']
  setExternalDeleteTarget: (target: null) => void
  confirmDeleteExternalAutomation: () => void
}

export function AutomationsPageDeleteDialogs({
  deleteTarget,
  dontAskDeleteAgain,
  deleteConfirmButtonRef,
  setDeleteTarget,
  setDontAskDeleteAgain,
  confirmDeleteAutomation,
  externalDeleteTarget,
  externalDeleteConfirmButtonRef,
  setExternalDeleteTarget,
  confirmDeleteExternalAutomation
}: Props): React.JSX.Element {
  return (
    <>
      <AutomationDeleteDialog
        deleteTarget={deleteTarget}
        dontAskDeleteAgain={dontAskDeleteAgain}
        confirmButtonRef={deleteConfirmButtonRef}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDontAskDeleteAgain(false)
          }
        }}
        onDontAskAgainToggle={() => setDontAskDeleteAgain(!dontAskDeleteAgain)}
        onCancel={() => {
          setDeleteTarget(null)
          setDontAskDeleteAgain(false)
        }}
        onConfirm={confirmDeleteAutomation}
      />
      <ExternalAutomationDeleteDialog
        externalDeleteTarget={externalDeleteTarget}
        confirmButtonRef={externalDeleteConfirmButtonRef}
        onOpenChange={(open) => {
          if (!open) {
            setExternalDeleteTarget(null)
          }
        }}
        onCancel={() => setExternalDeleteTarget(null)}
        onConfirm={confirmDeleteExternalAutomation}
      />
    </>
  )
}
