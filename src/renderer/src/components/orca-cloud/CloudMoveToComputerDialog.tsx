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
  effectiveArchiveAfter,
  setMoveArchiveAfter,
  useCloudMoveState,
  type CloudMoveState
} from '@/lib/orca-cloud/orca-cloud-move-store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { runArchiveCloudWorkspace } from './cloud-workspace-actions'
import { returnFocusToWorkspace } from './cloud-focus-return'
import {
  CloudMoveToComputerView,
  cloudMoveStepLabel,
  cloudMoveTitle,
  type CloudMoveConflicts
} from './CloudMoveToComputerView'

export type { CloudMoveConflicts } from './CloudMoveToComputerView'

/** Hide unmounts the dialog; give focus back to the workspace instead of leaving it on <body>. */
function hideAndReturnFocus(): void {
  hideRunningMove(true)
  requestAnimationFrame(() =>
    returnFocusToWorkspace(useAppStore.getState().activeTabId, (tabId) =>
      focusTerminalTabSurface(tabId, null, { onlyIfFocusUnclaimed: true })
    )
  )
}

/**
 * While hidden, a move is a notice: loading with Show; when it settles, success with Open
 * workspace or an error with Show details. The dialog only comes back on Show, so a move that
 * finishes while someone types never takes their focus.
 */
function useHiddenMoveToast(state: CloudMoveState, t: Translate): void {
  const hidden = state.stage !== 'closed' && state.stage !== 'confirm' && state.hidden
  const key = hidden ? `${state.stage}:${state.stage === 'running' ? state.step : ''}` : null
  useEffect(() => {
    const id = 'orca-cloud-move-hidden'
    const current = state
    if (!key || current.stage === 'closed' || current.stage === 'confirm') {
      toast.dismiss(id)
      return
    }
    const show = { label: t('orcaCloudMove.show', 'Show'), onClick: () => hideRunningMove(false) }
    if (current.stage === 'running') {
      toast.loading(
        t('orcaCloudMove.title.running', 'Moving {{name}} to this computer', {
          name: current.name
        }),
        {
          id,
          duration: Infinity,
          description: cloudMoveStepLabel(current.step, t),
          action: show
        }
      )
    } else if (current.stage === 'done') {
      toast.success(
        t('orcaCloudMove.notice.done', '{{name}} is on this computer', { name: current.name }),
        {
          id,
          duration: 12_000,
          action: {
            label: t('orcaCloudMove.done.open', 'Open workspace'),
            onClick: () => {
              closeMoveToThisComputer()
              activateAndRevealWorktree(current.localWorktreeId)
            }
          }
        }
      )
    } else {
      toast.error(
        t('orcaCloudMove.title.failed', 'Couldn’t move {{name}}', { name: current.name }),
        {
          id,
          duration: Infinity,
          action: {
            label: t('orcaCloudMove.showDetails', 'Show details'),
            onClick: () => hideRunningMove(false)
          }
        }
      )
    }
    // `key` captures the parts that change what the notice says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, t])
}

/** Mounted once in App; renders whatever move is open. */
export function CloudMoveToComputerDialogHost({
  conflictsFor,
  runningAgentsFor
}: {
  conflictsFor: (workspaceId: string) => CloudMoveConflicts
  runningAgentsFor: (workspaceId: string) => number
}): React.JSX.Element | null {
  const t = useTranslate()
  const state = useCloudMoveState()
  const now = useNow(1_000, state.stage === 'running')
  useHiddenMoveToast(state, t)
  if (state.stage === 'closed' || (state.stage !== 'confirm' && state.hidden)) {
    return null
  }
  const runningAgents = state.stage === 'confirm' ? runningAgentsFor(state.workspaceId) : 0
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
          runningAgents={runningAgents}
          now={now}
          onConfirm={() =>
            void runOrcaCloudTransferToLocal(state.workspaceId, state.name, {
              archiveAfter:
                state.stage === 'confirm'
                  ? effectiveArchiveAfter(state.archiveAfter, runningAgents)
                  : state.stage === 'running' || state.stage === 'failed'
                    ? state.archiveAfter
                    : false,
              onArchive: archive
            })
          }
          onArchiveAfterChange={setMoveArchiveAfter}
          onHide={hideAndReturnFocus}
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
