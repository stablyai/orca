import type { BrowserWorkspace } from '../../../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../../../shared/tab-types'

/** Browser records keep their source host/workspace when their view is placed elsewhere. */
export function workspaceBrowserTabs(
  records: Record<string, readonly BrowserWorkspace[] | undefined>,
  workspaceId: string,
  tabs: readonly Tab[] | undefined
): BrowserWorkspace[] {
  const ids = new Set(
    tabs?.filter((tab) => tab.contentType === 'browser').map((tab) => tab.entityId)
  )
  return Object.values(records).flatMap((workspaces) =>
    (workspaces ?? []).filter(
      (workspace) => workspace.worktreeId === workspaceId || ids.has(workspace.id)
    )
  )
}
