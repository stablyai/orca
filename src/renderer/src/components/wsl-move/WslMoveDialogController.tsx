import React, { Suspense, useEffect } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'
import { useWslMoveDialogStore } from './wsl-move-dialog-store'
import { collectWslMoveSleptPaneBindings } from './wsl-move-slept-pane-bindings'
import { followWslMoveOrchestratorStatus } from './wsl-move-orchestrator-status'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { getWslDistroFromPath } from '@/runtime/hosts/preflight/local-preflight-context'
import { adoptWslMoveProgress } from './wsl-move-run-adoption'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import { useConfirmationDialog } from '../dismiss/confirmation/confirmation-dialog-context'
import { useWslMoveQuitGuard } from './use-wsl-move-quit-guard'

const WslMoveDialogModal = lazy(() =>
  import('./WslMoveDialogModal').then((m) => ({ default: m.WslMoveDialogModal }))
)

export default function WslMoveDialogController(): React.JSX.Element | null {
  const confirm = useConfirmationDialog()
  useWslMoveQuitGuard(true, confirm)
  const open = useWslMoveDialogStore(
    (s) => s.dialog.stage !== 'closed' && !('hidden' in s.dialog && s.dialog.hidden)
  )
  // D3a-2: the per-distro move state for the host rows' status lines, only while hosts are on.
  useEffect(() => followWslMoveOrchestratorStatus(), [])
  // A run this window did not start (it reloaded mid-move) still gets its progress and reload.
  useEffect(() => window.api.wslMove.onProgress(adoptWslMoveProgress), [])
  // Opening a bridge project is the trigger bridge users give; main checks it runs.
  const activeWslDistro = useAppStore((s) => {
    const worktree = s.activeWorktreeId ? findWorktreeById(s, s.activeWorktreeId) : null
    return worktree ? getWslDistroFromPath(worktree.path) : null
  })
  useEffect(() => {
    if (activeWslDistro) {
      void window.api.wslMove.orchestratorProjectOpened(activeWslDistro)
    }
  }, [activeWslDistro])
  // An automatic move (D3a) needs this window's slept-pane bindings, as the dialog's start does.
  useEffect(
    () =>
      window.api.wslMove.onOrchestratorSleptPanesRequest((requestId) => {
        void window.api.wslMove.answerOrchestratorSleptPanes(
          requestId,
          collectWslMoveSleptPaneBindings(useAppStore.getState())
        )
      }),
    []
  )
  return open ? (
    <RecoverableRenderErrorBoundary boundaryId="modal.wsl-move" surface="modal" compact>
      <Suspense fallback={null}>
        <WslMoveDialogModal />
      </Suspense>
    </RecoverableRenderErrorBoundary>
  ) : null
}
