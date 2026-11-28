import React, { Suspense } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store'
import { useWorkspaceCleanupRunStore } from './workspace-cleanup-run-store'

const LazyWorkspaceCleanupRunCardContent = lazyWithRetry(
  () =>
    import('./WorkspaceCleanupRunCardContent').then((module) => ({
      default: module.WorkspaceCleanupRunCardContent
    })),
  { reloadKey: 'workspace-cleanup-run-card-content' }
)

/** Bottom-right card for a delete that outlives its dialog; stays until dismissed once finished. */
export function WorkspaceCleanupRunCard(): React.JSX.Element | null {
  const run = useWorkspaceCleanupRunStore((s) => s.run)
  const dialogOpen = useAppStore((s) => s.activeModal === 'workspace-cleanup')
  const dismissRun = useWorkspaceCleanupRunStore((s) => s.dismissRun)
  // The dialog already shows this run, so the card steps aside while it is open.
  if (run === null || dialogOpen) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <LazyWorkspaceCleanupRunCardContent run={run} onDismiss={() => dismissRun(run.id)} />
    </Suspense>
  )
}
