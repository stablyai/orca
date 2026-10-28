import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { resolveWorkspaceViewTab, selectShownWorkspaceView } from '@/lib/workspace-view-catalog'
import { measureWorkspaceViewLayout } from '@/lib/workspace-view-layout'
import { WorkspaceViewPanelSlot } from './WorkspaceViewPanelSlot'
import type { WorkspaceViewPlacement } from './workspace-view-projection'
import { useWorkspaceViewCatalogState } from './use-workspace-view-catalog-state'

export function useWorkspaceViewSurfaceProjection(
  workspaceId: string
): readonly WorkspaceViewPlacement[] | null {
  const view = useAppStore(selectShownWorkspaceView)
  const expanded = useAppStore((state) => state.workspaceViewExpandedPanelId)
  const tabSnapshot = useWorkspaceViewCatalogState(
    Boolean(view?.panels.some((panel) => panel.workspaceId === workspaceId))
  )
  return useMemo(
    () =>
      view
        ? view.panels.flatMap((panel) => {
            if (panel.workspaceId !== workspaceId) {
              return []
            }
            const tab = tabSnapshot ? resolveWorkspaceViewTab(tabSnapshot, panel) : null
            return tab
              ? [
                  {
                    panel,
                    tab,
                    visible: !expanded || expanded === panel.id,
                    focused: view.focusedPanelId === panel.id
                  }
                ]
              : []
          })
        : null,
    [view, expanded, workspaceId, tabSnapshot]
  )
}

export function WorkspaceViewSurfacePanels({
  projection
}: {
  projection: readonly WorkspaceViewPlacement[]
}): React.JSX.Element {
  const view = useAppStore(selectShownWorkspaceView)
  const expanded = useAppStore((state) => state.workspaceViewExpandedPanelId)
  const rects = useMemo(
    () => measureWorkspaceViewLayout(view?.layout ?? null).panels,
    [view?.layout]
  )
  return (
    <>
      {projection.map((item) => {
        const rect =
          expanded === item.panel.id
            ? { left: 0, top: 0, width: 100, height: 100 }
            : rects.get(item.panel.id)
        return rect && item.visible ? (
          <WorkspaceViewPanelSlot
            key={item.tab.id}
            panel={item.panel}
            tab={item.tab}
            rect={rect}
            focused={item.focused}
            expanded={expanded === item.panel.id}
          />
        ) : null
      })}
    </>
  )
}
