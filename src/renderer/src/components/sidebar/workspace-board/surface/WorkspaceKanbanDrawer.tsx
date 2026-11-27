import React, { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useWorkspaceKanbanDrawerLingering } from './use-workspace-kanban-drawer-lingering'

const WorkspaceKanbanDrawerContent = lazy(() => import('./WorkspaceKanbanDrawerContent'))

export type WorkspaceKanbanDrawerProps = {
  leftSidebarStyle?: React.CSSProperties
  open: boolean
  statusBarVisible: boolean
  dragPreview: boolean
  preserveOpenForMenu: boolean
  onOpenChange: (open: boolean) => void
  onMenuOpenChange: (open: boolean) => void
}

export default function WorkspaceKanbanDrawer(
  props: WorkspaceKanbanDrawerProps
): React.JSX.Element | null {
  const lingering = useWorkspaceKanbanDrawerLingering(props.open)

  if (!props.open && !lingering) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <WorkspaceKanbanDrawerContent {...props} />
    </Suspense>
  )
}
