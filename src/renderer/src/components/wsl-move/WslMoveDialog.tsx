import React, { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useWslHostsEnabled } from '../../runtime/hosts/wsl/use-wsl-hosts-enabled'

const WslMoveDialogController = lazy(() => import('./WslMoveDialogController'))

/** Root-hosted: entry points in Settings, the sidebar and project settings all open it. */
export function WslMoveDialogHost(): React.JSX.Element | null {
  const enabled = useWslHostsEnabled()
  if (!enabled) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <WslMoveDialogController />
    </Suspense>
  )
}
