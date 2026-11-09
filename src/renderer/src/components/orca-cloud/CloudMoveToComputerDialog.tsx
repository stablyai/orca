// "Move to this computer" dialog host: mounted once in App, renders whatever move is open.
import React, { useEffect } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useNow } from '@/hooks/use-now'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { runOrcaCloudTransferToLocal } from '@/lib/orca-cloud-transfer-flow'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  closeMoveToThisComputer,
  hideRunningMove,
  setMoveArchiveAfter,
  useCloudMoveState,
  type CloudMoveState
} from '@/lib/orca-cloud/orca-cloud-move-store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { runArchiveCloudWorkspace } from './cloud-workspace-actions'
import {
  CloudMoveToComputerView,
  cloudMoveStepLabel,
  cloudMoveTitle,
  type CloudMoveConflicts
} from './CloudMoveToComputerView'

export type { CloudMoveConflicts } from './CloudMoveToComputerView'

/** While hidden, a running move shows as a quiet loading notice with Show. */
function useHiddenMoveToast(state: CloudMoveState, t: Translate): void {
  const hiddenStep = state.stage === 'running' && state.hidden ? state.step : null
  const name = state.stage === 'closed' ? null : state.name
  useEffect(() => {
    const id = 'orca-cloud-move-hidden'
    if (!hiddenStep || !name) {
      toast.dismiss(id)
      return
    }
    toast.loading(t('orcaCloudMove.title.running', 'Moving {{name}} to this computer', { name }), {
      id,
      duration: Infinity,
      description: cloudMoveStepLabel(hiddenStep, t),
      action: { label: t('orcaCloudMove.show', 'Show'), onClick: () => hideRunningMove(false) }
    })
  }, [hiddenStep, name, t])
}

/** Mounted once in App; renders whatever move is open. */
export function CloudMoveToComputerDialogHost({
  conflictsFor
}: {
  conflictsFor: (workspaceId: string) => CloudMoveConflicts
}): React.JSX.Element | null {
  const t = useTranslate()
  const state = useCloudMoveState()
  const now = useNow(1_000, state.stage === 'running')
  useHiddenMoveToast(state, t)
  if (state.stage === 'closed' || (state.stage === 'running' && state.hidden)) {
    return null
  }
  const running = state.stage === 'running'
  const archive = (workspaceId: string, name: string): void =>
    void runArchiveCloudWorkspace(workspaceId, { name })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (running) {
            hideRunningMove(true)
          } else {
            closeMoveToThisComputer()
          }
        }
      }}
    >
      <DialogContent
        // Anchored near the top so the dialog doesn't jump as stages change height.
        className="top-[18vh] max-w-md translate-y-0"
        // No X while a move runs: Hide keeps it going behind a notice instead.
        showCloseButton={!running}
      >
        <DialogHeader>
          <DialogTitle>{cloudMoveTitle(state, t)}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('orcaCloudMove.description', 'Copy this cloud workspace to a local workspace.')}
          </DialogDescription>
        </DialogHeader>
        <CloudMoveToComputerView
          state={state}
          conflicts={conflictsFor(state.workspaceId)}
          now={now}
          onConfirm={() =>
            void runOrcaCloudTransferToLocal(state.workspaceId, state.name, {
              archiveAfter:
                state.stage === 'confirm'
                  ? state.archiveAfter
                  : state.stage === 'running'
                    ? state.archiveAfter
                    : false,
              onArchive: archive
            })
          }
          onArchiveAfterChange={setMoveArchiveAfter}
          onHide={() => hideRunningMove(true)}
          onCancel={closeMoveToThisComputer}
          onClose={closeMoveToThisComputer}
          onOpenLocal={(worktreeId) => activateAndRevealWorktree(worktreeId)}
          onOpenFolder={(dir) => void window.api.shell.openPath(dir, LOCAL_EXECUTION_HOST_ID)}
          onArchiveCloud={() => {
            closeMoveToThisComputer()
            archive(state.workspaceId, state.name)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
