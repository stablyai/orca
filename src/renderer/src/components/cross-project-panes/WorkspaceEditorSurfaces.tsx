import { lazy, Suspense, useLayoutEffect, useState } from 'react'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import { toVisibleTabType } from '../../../../shared/tab-types'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import { usePaneOverlayAssignments } from './use-pane-overlay-assignments'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))
const EMPTY_TABS: Tab[] = []

function EditorSurface({
  tab,
  viewId,
  paneId,
  visible,
  focused,
  focus
}: {
  tab: Tab
  viewId: string
  paneId?: string
  visible: boolean
  focused: boolean
  focus: (id: string) => void
}) {
  const [mounted, setMounted] = useState(visible)
  useLayoutEffect(() => {
    if (visible) {
      setMounted(true)
    }
  }, [visible])
  if (!mounted && !visible) {
    return null
  }
  const anchor = paneId ? tabGroupBodyAnchorName(paneId) : undefined
  return (
    <div
      data-editor-overlay-tab-id={tab.id}
      onPointerDown={() => paneId && focus(paneId)}
      onFocusCapture={() => paneId && focus(paneId)}
      className="absolute flex min-w-0 min-h-0"
      style={
        {
          positionAnchor: anchor,
          top: `anchor(${anchor} top)`,
          left: `anchor(${anchor} left)`,
          width: `anchor-size(${anchor} width)`,
          height: `anchor-size(${anchor} height)`,
          display: visible ? 'flex' : 'none',
          pointerEvents: visible ? 'auto' : 'none'
        } as React.CSSProperties
      }
    >
      <Suspense fallback={null}>
        <EditorPanel
          activeFileId={tab.entityId}
          activeViewStateId={viewId}
          isVisible={visible}
          isCmdSaveOwner={visible && focused}
        />
      </Suspense>
    </div>
  )
}

export function WorkspaceEditorSurfaces({
  worktreeId,
  isVisible
}: {
  worktreeId: string
  isVisible: boolean
}) {
  const tabs = useAppStore((s) => s.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const presentation = usePaneOverlayAssignments(worktreeId)
  const layout = useAppStore((s) => s.windowPaneLayout)
  const views = Object.values(layout?.panes ?? {}).flatMap((pane) =>
    pane.viewIds.flatMap((id) => {
      const view = layout?.views[id]
      const tab = tabs.find((tab) => tab.id === view?.tabId)
      return tab && toVisibleTabType(tab.contentType) === 'editor'
        ? [
            {
              id,
              tab,
              pane,
              visible:
                pane.selectedViewId === id &&
                (!layout?.expandedPaneId || layout.expandedPaneId === pane.id)
            }
          ]
        : []
    })
  )
  return (
    <>
      {views.map(({ id, tab, pane, visible }) => {
        return (
          <EditorSurface
            key={id}
            viewId={id}
            tab={tab}
            paneId={pane.id}
            visible={isVisible && visible}
            focused={layout?.activePaneId === pane.id}
            focus={presentation.focus}
          />
        )
      })}
    </>
  )
}
