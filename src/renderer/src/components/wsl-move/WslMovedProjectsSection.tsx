import React, { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store'

const WslMovedProjectsSectionSurface = lazy(() => import('./WslMovedProjectsSectionSurface'))

/**
 * Projects a WSL host now owns, listed read-only with the chats that stay on this computer, if any.
 * Undo brings a project back here as it was before the move; some entries can be hidden, since
 * their host row's menu offers the same undo (`canHideWslMovedEntry`). The rest is the host's.
 */
const WslMovedProjectsSection = React.memo(function WslMovedProjectsSection() {
  const hasMovedProjects = useAppStore((state) => state.wslMovedProjects.length > 0)
  if (!hasMovedProjects) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <WslMovedProjectsSectionSurface />
    </Suspense>
  )
})

export default WslMovedProjectsSection
