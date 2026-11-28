import React from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  isLocalToolchainFailure,
  resolveRepoScanFailure
} from '../../../repo/toolchain/repo-scan-failure'
import { selectDetectedWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

const LazyRepoWslDistroStoppedIndicator = lazyWithRetry(
  () =>
    import('./RepoWslDistroStoppedIndicator').then((module) => ({
      default: module.RepoWslDistroStoppedIndicator
    })),
  { reloadKey: 'repo-wsl-distro-stopped-indicator' }
)

const LazyRepoScanUnavailableBadge = lazyWithRetry(
  () =>
    import('./RepoScanUnavailableBadge').then((module) => ({
      default: module.RepoScanUnavailableBadge
    })),
  { reloadKey: 'repo-scan-unavailable-badge' }
)

/** Retain failed-scan rows with a warning and explicit retry instead of waiting for an incidental refresh. */
export function RepoScanUnavailableIndicator({ repo }: { repo: Repo }): React.JSX.Element | null {
  const detected = useAppStore((s) => selectDetectedWorktreesByRepo(s)[repo.id])
  if (detected && !detected.authoritative && detected.wslDistroStopped) {
    return (
      <React.Suspense fallback={null}>
        <LazyRepoWslDistroStoppedIndicator repo={repo} notRunning={detected.wslDistroStopped} />
      </React.Suspense>
    )
  }
  const failure = resolveRepoScanFailure(repo, detected)
  // Why: machine-wide failures are explained once by the sidebar banner, not on every repo.
  if (!failure || isLocalToolchainFailure(failure)) {
    return null
  }
  return (
    <React.Suspense fallback={null}>
      <LazyRepoScanUnavailableBadge repo={repo} failure={failure} />
    </React.Suspense>
  )
}
