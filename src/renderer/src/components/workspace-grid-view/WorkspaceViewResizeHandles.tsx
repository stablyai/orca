import { useMemo, useRef } from 'react'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { updateSplitRatio } from '../../../../shared/workspace-layout/tab-group-layout-tree'
import { useAppStore } from '@/store'
import { selectShownWorkspaceView } from '@/lib/workspace-view-catalog'
import { measureWorkspaceViewLayout } from '@/lib/workspace-view-layout'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { TabGroupResizeHandle } from '../tab-group/TabGroupResizeHandle'

export function WorkspaceViewResizeHandles(): React.JSX.Element | null {
  const view = useAppStore(selectShownWorkspaceView)
  const expanded = useAppStore((state) => state.workspaceViewExpandedPanelId)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const geometry = useMemo(() => measureWorkspaceViewLayout(view?.layout ?? null), [view?.layout])
  function preview(layout: TabGroupLayoutNode, path: string[], ratio: number): void {
    if (useAppStore.getState().activeWorkspaceViewId !== view?.id) {
      return
    }
    const root = rootRef.current?.parentElement
    if (!root) {
      return
    }
    const next = measureWorkspaceViewLayout(updateSplitRatio(layout, path, ratio))
    for (const node of root.querySelectorAll<HTMLElement>('[data-workspace-view-panel-id]')) {
      const rect = next.panels.get(node.dataset.workspaceViewPanelId ?? '')
      if (rect) {
        Object.assign(node.style, {
          left: `${rect.left}%`,
          top: `${rect.top}%`,
          width: `${rect.width}%`,
          height: `${rect.height}%`
        })
      }
    }
  }
  if (!view?.layout || expanded) {
    return null
  }
  const layout = view.layout
  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-20">
      {geometry.splits.map((split) => (
        <div
          key={split.path.join('.')}
          className={cn(
            'pointer-events-none absolute flex min-h-0 min-w-0',
            split.direction === 'vertical' && 'flex-col'
          )}
          style={{
            left: `${split.rect.left}%`,
            top: `${split.rect.top}%`,
            width: `${split.rect.width}%`,
            height: `${split.rect.height}%`
          }}
        >
          <div style={{ flex: `${split.ratio} 1 0%` }} />
          <TabGroupResizeHandle
            direction={split.direction}
            ratio={split.ratio}
            label={translate('workspaceViews.resizePanels', 'Resize panels')}
            onResizeStart={() => {}}
            onRatioPreview={(ratio) => preview(layout, split.path, ratio)}
            onRatioChange={(ratio) => {
              if (useAppStore.getState().activeWorkspaceViewId === view.id) {
                useAppStore.getState().setWorkspaceViewRatio(split.path, ratio)
              }
            }}
          />
          <div style={{ flex: `${1 - split.ratio} 1 0%` }} />
        </div>
      ))}
    </div>
  )
}
