import { useAppStore } from '@/store'
import type { WorkspacePaneDropTarget } from '../../../../shared/window-pane-types'
import { resolvePaneColumnEdgeZone } from '../tab-group/tab-drop-zone'
import { projectPaneContext } from './project-pane-context'

export function workspacePaneDropTarget(point: {
  x: number
  y: number
}): { target: WorkspacePaneDropTarget; label: string; rect: DOMRect } | null {
  const state = useAppStore.getState()
  const layout = state.windowPaneLayout
  if (!layout) {
    return null
  }
  for (const element of document.querySelectorAll<HTMLElement>('section[data-pane-id]')) {
    const rect = element.getBoundingClientRect()
    if (
      point.x < rect.left ||
      point.x > rect.right ||
      point.y < rect.top ||
      point.y > rect.bottom
    ) {
      continue
    }
    const paneId = element.dataset.paneId!
    const pane = layout.panes[paneId]
    if (!pane) {
      continue
    }
    const body = element
      .querySelector<HTMLElement>('[data-tab-group-body-id]')!
      .getBoundingClientRect()
    const context = projectPaneContext(
      state,
      layout.views[pane.selectedViewId ?? ''] ?? pane.workspace
    )
    const destination = `${context.projectName} / ${context.workspace}`
    if (point.y < body.top) {
      const tabs = [...element.querySelectorAll<HTMLElement>('[data-workspace-view-id]')]
      const before = tabs.find((tab) => {
        const bounds = tab.getBoundingClientRect()
        return point.x < bounds.left + bounds.width / 2
      })
      return {
        target: {
          paneId,
          zone: 'center',
          ...(before ? { beforeViewId: before.dataset.workspaceViewId } : {})
        },
        label: `Insert as tab in ${destination}`,
        rect
      }
    }
    const zone = resolvePaneColumnEdgeZone(rect, point, { bodyRect: body }) ?? 'center'
    return {
      target: { paneId, zone },
      label:
        zone === 'center'
          ? `Insert as tab in ${destination}`
          : `Split ${zone === 'up' ? 'above' : zone === 'down' ? 'down' : zone} of ${destination}`,
      rect: body
    }
  }
  return null
}
