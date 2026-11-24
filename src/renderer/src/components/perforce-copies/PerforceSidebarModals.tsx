import { useAppStore } from '@/store/index'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'

const PerforceCopyDeleteModal = lazyWithRetry(() => import('./PerforceCopyDeleteModal'))
const PerforceCopyUpModal = lazyWithRetry(() => import('./PerforceCopyUpModal'))
const PerforceCopiesModal = lazyWithRetry(() => import('./PerforceCopiesModal'))
const PerforceOpenForEditDialog = lazyWithRetry(
  () => import('../right-sidebar/perforce/PerforceOpenForEditDialog')
)

/** The sidebar's Perforce modals; render inside the sidebar's modal Suspense boundary. */
export function PerforceSidebarModals(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  switch (activeModal) {
    case 'delete-perforce-copy':
      return <PerforceCopyDeleteModal />
    case 'copy-up-perforce-copy':
      return <PerforceCopyUpModal />
    case 'perforce-copies':
      return <PerforceCopiesModal />
    case 'perforce-open-for-edit':
      return <PerforceOpenForEditDialog />
    default:
      return null
  }
}
