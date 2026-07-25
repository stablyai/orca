/**
 * User Panels host for collab boards (G3).
 * One CollabCanvas per visited panel with binding.kind === 'panel'.
 */
import React, { lazy, Suspense } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PinnedCanvasPanel } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

const CollabCanvas = lazy(() =>
  import('../collab-canvas/CollabCanvas').then((m) => ({ default: m.CollabCanvas }))
)

const EMPTY: readonly PinnedCanvasPanel[] = []

const PinnedCanvasPanelPage = React.memo(function PinnedCanvasPanelPage(): React.JSX.Element | null {
  useTranslation()
  const panels = useAppStore((s) => s.settings?.pinnedCanvasPanels ?? EMPTY)
  const activeView = useAppStore((s) => s.activeView)
  const activePanelId = useAppStore((s) => s.activePinnedCanvasPanelId)
  const closePage = useAppStore((s) => s.closePinnedCanvasPanelPage)
  const [visited, setVisited] = React.useState<readonly string[]>([])

  const pageVisible = activeView === 'canvas-panel' && activePanelId !== null
  const activePanel = panels.find((p) => p.id === activePanelId)

  React.useEffect(() => {
    if (pageVisible && activePanelId) {
      setVisited((prev) => (prev.includes(activePanelId) ? prev : [...prev, activePanelId]))
    }
  }, [pageVisible, activePanelId])

  React.useEffect(() => {
    const ids = new Set(panels.map((p) => p.id))
    setVisited((prev) => prev.filter((id) => ids.has(id)))
  }, [panels])

  React.useEffect(() => {
    if (activeView === 'canvas-panel' && !activePanel) {
      closePage()
    }
  }, [activeView, activePanel, closePage])

  const visitedPanels = panels.filter((p) => visited.includes(p.id))
  if (visitedPanels.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'absolute inset-0 z-10 flex min-h-0 flex-col bg-background',
        pageVisible ? 'flex' : 'hidden'
      )}
      data-pinned-canvas-panel-page
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <span className="text-sm font-medium">
          {activePanel?.title ??
            translate('auto.components.pinned.canvas.board', 'Collab board')}
        </span>
        <span className="truncate text-xs text-muted-foreground" title={activePanel?.boardId}>
          {activePanel?.boardId}
        </span>
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => closePage()}
            title={translate('auto.common.close', 'Close')}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {visitedPanels.map((panel) => {
          const visible = panel.id === activePanelId && pageVisible
          return (
            <div
              key={panel.id}
              className={cn('absolute inset-0', visible ? 'flex' : 'hidden')}
              data-pinned-canvas-panel-id={panel.id}
            >
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Loading collab board...
                  </div>
                }
              >
                <CollabCanvas
                  binding={{ kind: 'panel', panelId: panel.id, boardId: panel.boardId }}
                />
              </Suspense>
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default PinnedCanvasPanelPage
