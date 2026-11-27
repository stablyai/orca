import { Suspense, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'

const RunningTerminalCloseDialogSurface = lazy(() => import('./RunningTerminalCloseDialogSurface'))

/** Store-driven running-process confirmation lets tab/group/floating closes share the pane keyboard guard outside React context. */
export default function RunningTerminalCloseDialog(): React.JSX.Element | null {
  const hasRequest = useRunningTerminalCloseConfirmStore(
    (state) => state.runningTerminalCloseConfirm !== null
  )
  const hasPinnedRequest = useAppStore((state) => state.pinnedTabCloseConfirm !== null)
  const shouldOpen = hasRequest && !hasPinnedRequest
  const [hasOpened, setHasOpened] = useState(shouldOpen)

  if (shouldOpen && !hasOpened) {
    setHasOpened(true)
  }

  if (!hasOpened) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <RunningTerminalCloseDialogSurface />
    </Suspense>
  )
}
