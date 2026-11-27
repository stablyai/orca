import { Suspense, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'

const PinnedTabCloseDialogSurface = lazy(() => import('./PinnedTabCloseDialogSurface'))

/** Store-driven confirmation lets keyboard, native menu and CLI closes share the pinned-tab guard outside React context. */
export default function PinnedTabCloseDialog(): React.JSX.Element | null {
  const hasRequest = useAppStore((state) => state.pinnedTabCloseConfirm !== null)
  const [hasOpened, setHasOpened] = useState(hasRequest)

  if (hasRequest && !hasOpened) {
    setHasOpened(true)
  }

  if (!hasOpened) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <PinnedTabCloseDialogSurface />
    </Suspense>
  )
}
