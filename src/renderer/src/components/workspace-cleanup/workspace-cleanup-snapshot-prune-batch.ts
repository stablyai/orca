import type { WorkspaceCleanupBackgroundRemovalArgs } from './workspace-cleanup-background-removal'
import { createBrowserUuid } from '@/lib/browser-uuid'

export function createWorkspaceCleanupSnapshotPruneBatch():
  | WorkspaceCleanupBackgroundRemovalArgs['snapshotPruneBatch']
  | undefined {
  const begin = window.api.workspaceCleanup.beginRemovalSnapshotPruneBatch
  const record = window.api.workspaceCleanup.recordRemovalSnapshotPrune
  const finish = window.api.workspaceCleanup.finishRemovalSnapshotPruneBatch
  if (typeof begin !== 'function' || typeof record !== 'function' || typeof finish !== 'function') {
    return undefined
  }
  const batchId = createBrowserUuid()
  return {
    batchId,
    begin: () => begin({ batchId }),
    finish: () => finish({ batchId })
  }
}
