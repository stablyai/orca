import { parseExecutionHostId } from '../../../shared/execution-host'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import {
  buildWorkspaceViewLayout,
  workspaceViewPanelKey,
  WORKSPACE_VIEW_MAX_PANELS,
  WORKSPACE_VIEW_MAX_SAVED,
  type WorkspaceView,
  type WorkspaceViewPanel
} from './workspace-view-layout'

const STORAGE_KEY = 'orca.workspace-views.v1'
type SavedWorkspaceViews = { views: readonly WorkspaceView[]; activeId: string | null }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
}
function readPanel(value: unknown): WorkspaceViewPanel | null {
  if (
    !record(value) ||
    !text(value.id) ||
    !text(value.workspaceId) ||
    !text(value.tabId) ||
    !text(value.executionHostId) ||
    !text(value.title) ||
    !text(value.workspaceName) ||
    !text(value.projectName)
  ) {
    return null
  }
  const host = parseExecutionHostId(value.executionHostId)
  return host
    ? {
        id: value.id,
        workspaceId: value.workspaceId,
        tabId: value.tabId,
        executionHostId: host.id,
        title: value.title,
        workspaceName: value.workspaceName,
        projectName: value.projectName
      }
    : null
}
function readLayout(value: unknown, remaining: Set<string>, depth = 0): TabGroupLayoutNode | null {
  if (!record(value) || depth > WORKSPACE_VIEW_MAX_PANELS) {
    return null
  }
  if (value.type === 'leaf' && text(value.groupId) && remaining.delete(value.groupId)) {
    return { type: 'leaf', groupId: value.groupId }
  }
  if (
    value.type !== 'split' ||
    (value.direction !== 'horizontal' && value.direction !== 'vertical')
  ) {
    return null
  }
  const first = readLayout(value.first, remaining, depth + 1)
  const second = readLayout(value.second, remaining, depth + 1)
  if (!first || !second) {
    return null
  }
  const ratio =
    typeof value.ratio === 'number' && Number.isFinite(value.ratio)
      ? Math.max(0.15, Math.min(0.85, value.ratio))
      : 0.5
  return { type: 'split', direction: value.direction, first, second, ratio }
}
export function decodeWorkspaceViews(value: unknown): SavedWorkspaceViews {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.views)) {
    return { views: [], activeId: null }
  }
  const views: WorkspaceView[] = [],
    viewIds = new Set<string>()
  for (const candidate of value.views.slice(0, WORKSPACE_VIEW_MAX_SAVED)) {
    if (
      !record(candidate) ||
      !text(candidate.id) ||
      viewIds.has(candidate.id) ||
      !text(candidate.name) ||
      !Array.isArray(candidate.panels)
    ) {
      continue
    }
    const panels: WorkspaceViewPanel[] = [],
      ids = new Set<string>(),
      keys = new Set<string>()
    for (const raw of candidate.panels.slice(0, WORKSPACE_VIEW_MAX_PANELS)) {
      const panel = readPanel(raw)
      if (!panel || ids.has(panel.id) || keys.has(workspaceViewPanelKey(panel))) {
        continue
      }
      panels.push(panel)
      ids.add(panel.id)
      keys.add(workspaceViewPanelKey(panel))
    }
    const preset = candidate.preset === 'primary' ? 'primary' : 'grid'
    const remaining = new Set(ids),
      layout = readLayout(candidate.layout, remaining)
    views.push({
      id: candidate.id,
      name: candidate.name.slice(0, 80),
      panels,
      preset,
      layout: layout && remaining.size === 0 ? layout : buildWorkspaceViewLayout([...ids], preset),
      focusedPanelId:
        typeof candidate.focusedPanelId === 'string' && ids.has(candidate.focusedPanelId)
          ? candidate.focusedPanelId
          : (panels[0]?.id ?? null)
    })
    viewIds.add(candidate.id)
  }
  return {
    views,
    activeId:
      typeof value.activeId === 'string' && viewIds.has(value.activeId) ? value.activeId : null
  }
}
export function loadWorkspaceViews(): SavedWorkspaceViews {
  try {
    return decodeWorkspaceViews(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    return { views: [], activeId: null }
  }
}
export function saveWorkspaceViews(views: readonly WorkspaceView[], activeId: string | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, views, activeId }))
  } catch {
    /* Keep the current arrangement usable when device storage is unavailable. */
  }
}
