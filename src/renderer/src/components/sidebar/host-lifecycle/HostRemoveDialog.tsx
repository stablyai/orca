import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import type { HostRemoveDialogProps } from './HostRemoveDialogSurface'

const HostRemoveDialogSurface = lazy(() =>
  import('./HostRemoveDialogSurface').then((module) => ({
    default: module.HostRemoveDialog
  }))
)

export function HostRemoveDialog(props: HostRemoveDialogProps): React.JSX.Element | null {
  const hasOpened = useLatchedOpen(props.open)
  if (!hasOpened) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <HostRemoveDialogSurface {...props} />
    </Suspense>
  )
}
