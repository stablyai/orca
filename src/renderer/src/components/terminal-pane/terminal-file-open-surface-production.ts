import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  registerWorkspaceSurfaceProducer,
  type WorkspaceSurfaceProducer
} from '@/lib/workspace-surface-production'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

export function settleTerminalFileProducedTab(
  producer: WorkspaceSurfaceProducer,
  worktreeId: string,
  expectedSurfaceId?: string
): void {
  try {
    const state = useAppStore.getState()
    const reconciliation = state.reconcileWorktreeTabModel(worktreeId)
    const surfaceId = expectedSurfaceId ?? reconciliation.activeRenderableTabId
    const published = surfaceId
      ? (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
          (tab) => tab.id === surfaceId
        )
      : false
    if (surfaceId && published) {
      producer.materialized({ kind: 'tab', id: surfaceId })
      return
    }
    producer.failed('The requested tab did not become available.')
  } catch (error) {
    // Why: recovery bookkeeping must not interrupt an editor/browser open that already succeeded.
    producer.failed(error)
  }
}

export function openTerminalHtmlFileInBrowser(filePath: string, worktreeId: string): void {
  const store = useAppStore.getState()
  const fileUrl = absolutePathToFileUri(filePath)
  const title = filePath.split(/[/\\]/).pop() ?? filePath
  if (!worktreeId) {
    store.createBrowserTab(worktreeId, fileUrl, { title, activate: true })
    return
  }
  const producer = registerWorkspaceSurfaceProducer({
    workspaceKey: worktreeId,
    executionHostId: getExecutionHostIdForWorktree(store, worktreeId)
  })
  try {
    if (activateAndRevealWorktree(worktreeId) === false) {
      producer.failed('The workspace is no longer available.')
      return
    }
    const tab = store.createBrowserTab(worktreeId, fileUrl, { title, activate: true })
    settleTerminalFileProducedTab(producer, worktreeId, tab.id)
  } catch (error) {
    producer.failed(error)
  }
}
