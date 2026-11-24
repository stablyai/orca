import type { ReactElement } from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { WorkerTabMenuItems } from './WorkerTabMenuItems'
import { indexedWorkerTab } from './worker-tab-index'

export function WorkerAgentRowMenu({
  worktreeId,
  tabId,
  children
}: {
  worktreeId: string
  tabId: string
  children: ReactElement
}): React.JSX.Element {
  const tab = useAppStore((state) =>
    indexedWorkerTab(state.unifiedTabsByWorktree[worktreeId], tabId)
  )
  if (!tab) {
    return children
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onContextMenu={(event) => event.stopPropagation()}>
        <WorkerTabMenuItems worktreeId={worktreeId} groupId={tab.groupId} unifiedTabId={tab.id} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
