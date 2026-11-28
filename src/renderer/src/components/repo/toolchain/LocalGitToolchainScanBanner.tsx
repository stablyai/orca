import React from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'
import { findLocalToolchainBlock } from './repo-scan-failure'
import { selectDetectedWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

const LazyLocalGitToolchainScanBannerSurface = lazyWithRetry(
  () =>
    import('./LocalGitToolchainScanBannerSurface').then((module) => ({
      default: module.LocalGitToolchainScanBannerSurface
    })),
  { reloadKey: 'local-git-toolchain-scan-banner-surface' }
)

export function LocalGitToolchainScanBanner(): React.JSX.Element | null {
  const repos = useAppStore((s) => s.repos)
  const detectedByRepo = useAppStore((s) => selectDetectedWorktreesByRepo(s))
  const block = findLocalToolchainBlock(repos, detectedByRepo)
  if (!block) {
    return null
  }
  return (
    <React.Suspense fallback={null}>
      <LazyLocalGitToolchainScanBannerSurface block={block} />
    </React.Suspense>
  )
}
