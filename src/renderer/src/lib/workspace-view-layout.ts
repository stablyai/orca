import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'

export const WORKSPACE_VIEW_MAX_PANELS = 6
export const WORKSPACE_VIEW_MAX_SAVED = 20
export type WorkspaceViewPreset = 'grid' | 'primary'
export type WorkspaceViewRect = { left: number; top: number; width: number; height: number }

export type WorkspaceViewPanel = {
  id: string
  workspaceId: string
  executionHostId: ExecutionHostId
  tabId: string
  title: string
  workspaceName: string
  projectName: string
}

export type WorkspaceView = {
  id: string
  name: string
  panels: readonly WorkspaceViewPanel[]
  /** Leaves name presentation panels, never the workspace's persisted tab groups. */
  layout: TabGroupLayoutNode | null
  preset: WorkspaceViewPreset
  focusedPanelId: string | null
}

export type WorkspaceViewSplit = {
  path: string[]
  rect: WorkspaceViewRect
  direction: 'horizontal' | 'vertical'
  ratio: number
}

function joinLeaves(
  ids: readonly string[],
  direction: 'horizontal' | 'vertical'
): TabGroupLayoutNode {
  if (ids.length === 1) {
    return { type: 'leaf', groupId: ids[0] }
  }
  return {
    type: 'split',
    direction,
    ratio: 1 / ids.length,
    first: { type: 'leaf', groupId: ids[0] },
    second: joinLeaves(ids.slice(1), direction)
  }
}

export function buildWorkspaceViewLayout(
  ids: readonly string[],
  preset: WorkspaceViewPreset
): TabGroupLayoutNode | null {
  if (!ids.length) {
    return null
  }
  if (ids.length === 1) {
    return { type: 'leaf', groupId: ids[0] }
  }
  if (preset === 'primary') {
    return {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.6,
      first: { type: 'leaf', groupId: ids[0] },
      second: joinLeaves(ids.slice(1), 'vertical')
    }
  }
  const columns = Math.ceil(Math.sqrt(ids.length))
  const rows: TabGroupLayoutNode[] = []
  for (let offset = 0; offset < ids.length; offset += columns) {
    rows.push(joinLeaves(ids.slice(offset, offset + columns), 'horizontal'))
  }
  if (rows.length === 1) {
    return rows[0]
  }
  return { type: 'split', direction: 'vertical', ratio: 0.5, first: rows[0], second: rows[1] }
}

export function workspaceViewPanelKey(
  panel: Pick<WorkspaceViewPanel, 'executionHostId' | 'workspaceId' | 'tabId'>
): string {
  return JSON.stringify([panel.executionHostId, panel.workspaceId, panel.tabId])
}

export function workspaceViewAnchorId(panelId: string): string {
  return `workspace-view-${panelId}`
}

export function measureWorkspaceViewLayout(layout: TabGroupLayoutNode | null): {
  panels: Map<string, WorkspaceViewRect>
  splits: WorkspaceViewSplit[]
} {
  const panels = new Map<string, WorkspaceViewRect>()
  const splits: WorkspaceViewSplit[] = []
  function visit(node: TabGroupLayoutNode, rect: WorkspaceViewRect, path: string[]): void {
    if (node.type === 'leaf') {
      panels.set(node.groupId, rect)
      return
    }
    const ratio = Math.max(0.15, Math.min(0.85, node.ratio ?? 0.5))
    splits.push({ path, rect, direction: node.direction, ratio })
    const first = { ...rect },
      second = { ...rect }
    if (node.direction === 'horizontal') {
      first.width *= ratio
      second.left += first.width
      second.width -= first.width
    } else {
      first.height *= ratio
      second.top += first.height
      second.height -= first.height
    }
    visit(node.first, first, [...path, 'first'])
    visit(node.second, second, [...path, 'second'])
  }
  if (layout) {
    visit(layout, { left: 0, top: 0, width: 100, height: 100 }, [])
  }
  return { panels, splits }
}
