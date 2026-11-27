import React, { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store'
import { isRepoHidden } from '../../../../../shared/project/catalog/hidden-projects'

const HiddenProjectsSectionSurface = lazy(() => import('./HiddenProjectsSectionSurface'))

/** Collapsed list of hidden projects under the workspace list, each with a Show action. */
const HiddenProjectsSection = React.memo(function HiddenProjectsSection() {
  const hasHiddenRepos = useAppStore((state) => state.repos.some(isRepoHidden))
  if (!hasHiddenRepos) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <HiddenProjectsSectionSurface />
    </Suspense>
  )
})

export default HiddenProjectsSection
