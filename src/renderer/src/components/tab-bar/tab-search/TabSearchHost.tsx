import { Suspense, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { ModalBoundary } from '@/app-shell/root-surfaces/app-root-surface-boundaries'
import { useAppStore } from '@/store/index'

const TabSearch = lazy(() => import('./TabSearch'))

/** Fetches the popup on its first open and costs one boolean subscription before that. */
export function TabSearchHost(): React.JSX.Element | null {
  const open = useAppStore((s) => s.activeModal === 'tab-search')
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) {
    setMounted(true)
  }
  if (!mounted) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <ModalBoundary boundaryId="modal.tab-search" resetKey={open}>
        <TabSearch />
      </ModalBoundary>
    </Suspense>
  )
}
