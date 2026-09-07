import type { ExecutionHostId } from './execution-host'
import type { TabContentType, TabGroupLayoutNode } from './tab-types'

export type WorkspaceView = {
  id: string
  executionHostId: ExecutionHostId
  worktreeId: string
  tabId: string
  entityId: string
  contentType: TabContentType
  label?: string
  controlPending?: boolean
}

export type WorkspacePane = {
  id: string
  viewIds: string[]
  selectedViewId: string | null
  workspace?: Pick<WorkspaceView, 'worktreeId' | 'executionHostId'>
  dismissedTabKeys?: string[]
}

export type WorkspacePaneDropTarget = {
  paneId: string
  zone: 'center' | 'left' | 'right' | 'up' | 'down'
  beforeViewId?: string
}

export type WindowPaneLayout = {
  version: 1
  root: TabGroupLayoutNode
  activePaneId: string
  expandedPaneId: string | null
  panes: Record<string, WorkspacePane>
  views: Record<string, WorkspaceView>
}
