import React, { Suspense } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import type { ActivityBarPositionMenuProps } from './activity-bar-position-menu'

const LazyActivityBarPositionMenu = lazyWithRetry(
  () =>
    import('./activity-bar-position-menu').then((module) => ({
      default: module.ActivityBarPositionMenu
    })),
  { reloadKey: 'activity-bar-position-menu' }
)

export function ActivityBarPositionMenuHost({
  open,
  ...props
}: ActivityBarPositionMenuProps & { open: boolean }): React.JSX.Element | null {
  const hasOpened = useLatchedOpen(open)
  if (!hasOpened) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <LazyActivityBarPositionMenu {...props} />
    </Suspense>
  )
}
