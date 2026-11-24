import { ModalBoundary } from '@/app-shell/root-surfaces/app-root-surface-boundaries'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'

const AgentCliUpdateFailedDialog = lazy(() => import('./AgentCliUpdateFailedDialog'))

/** Mounted at the root, inside its Suspense, so the dialog outlives the popover that opened it. */
export function AgentCliUpdateFailedDialogHost(): React.JSX.Element | null {
  const open = useAppStore((s) => s.activeModal === 'agent-cli-update-failed')
  return open ? (
    <ModalBoundary boundaryId="modal.agent-cli-update-failed" resetKey>
      <AgentCliUpdateFailedDialog />
    </ModalBoundary>
  ) : null
}
