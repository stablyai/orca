import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import type { AddRemoteHostDialogProps, AddRemoteHostMode } from './AddRemoteHostDialogSurface'

export type { AddRemoteHostMode }

const AddRemoteHostDialogSurface = lazy(() =>
  import('./AddRemoteHostDialogSurface').then((module) => ({
    default: module.AddRemoteHostDialog
  }))
)

export function AddRemoteHostDialog(props: AddRemoteHostDialogProps): React.JSX.Element | null {
  const hasOpened = useLatchedOpen(props.mode !== null)
  if (!hasOpened) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <AddRemoteHostDialogSurface {...props} />
    </Suspense>
  )
}
