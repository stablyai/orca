import React from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Columns2,
  PictureInPicture2,
  RotateCw,
  Rows2,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PinnedWebPanel } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { detachPanelIntoWindow } from '@/lib/panel-canvas-detach'
import {
  destroyPinnedWebPanelWebview,
  ensurePinnedWebPanelWebview,
  getPinnedWebPanelNavState,
  navigatePinnedWebPanelWebview,
  reloadPinnedWebPanelWebview,
  subscribePinnedWebPanelNavState
} from './pinned-web-panel-webview'

const EMPTY_PANELS: readonly PinnedWebPanel[] = []

function PinnedWebPanelViewport({
  panel,
  visible
}: {
  panel: PinnedWebPanel
  visible: boolean
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (containerRef.current) {
      ensurePinnedWebPanelWebview({
        panelId: panel.id,
        url: panel.url,
        container: containerRef.current
      })
    }
  }, [panel.id, panel.url])

  // Why: display:none parks the guest (it survives); unmounting would destroy
  // it and force a full dashboard reload on the next visit.
  return (
    <div
      ref={containerRef}
      className={cn('min-h-0 flex-1 flex-col', visible ? 'flex' : 'hidden')}
      data-pinned-web-panel-id={panel.id}
    />
  )
}

/** Hosts every visited pinned panel; the inactive ones stay mounted but parked. */
const PinnedWebPanelPage = React.memo(function PinnedWebPanelPage(): React.JSX.Element | null {
  useTranslation()
  const panels = useAppStore((s) => s.settings?.pinnedWebPanels ?? EMPTY_PANELS)
  const activeView = useAppStore((s) => s.activeView)
  const activePanelId = useAppStore((s) => s.activePinnedWebPanelId)
  const closePinnedWebPanelPage = useAppStore((s) => s.closePinnedWebPanelPage)
  const openPanelInCanvas = useAppStore((s) => s.openPanelInCanvas)
  const [visitedPanelIds, setVisitedPanelIds] = React.useState<readonly string[]>([])

  const pageVisible = activeView === 'web-panel' && activePanelId !== null
  const activePanel = panels.find((panel) => panel.id === activePanelId)
  // Why: dashboards without their own chrome can strand the user mid-flow —
  // surface real back/forward controls driven by the guest's history state.
  const navState = React.useSyncExternalStore(subscribePinnedWebPanelNavState, () =>
    getPinnedWebPanelNavState(activePanelId)
  )

  React.useEffect(() => {
    if (pageVisible && activePanelId !== null) {
      setVisitedPanelIds((prev) => (prev.includes(activePanelId) ? prev : [...prev, activePanelId]))
    }
  }, [pageVisible, activePanelId])

  // Why: a panel deleted in Settings must release its guest immediately —
  // the session partition persists, so keeping the webview alive would keep
  // loading a page the user asked to remove.
  React.useEffect(() => {
    const panelIds = new Set(panels.map((panel) => panel.id))
    setVisitedPanelIds((prev) => {
      const kept = prev.filter((id) => panelIds.has(id))
      for (const id of prev) {
        if (!panelIds.has(id)) {
          destroyPinnedWebPanelWebview(id)
        }
      }
      return kept.length === prev.length ? prev : kept
    })
  }, [panels])

  React.useEffect(() => {
    if (activeView === 'web-panel' && !activePanel) {
      closePinnedWebPanelPage()
    }
  }, [activeView, activePanel, closePinnedWebPanelPage])

  const visitedPanels = panels.filter((panel) => visitedPanelIds.includes(panel.id))
  if (visitedPanels.length === 0) {
    return null
  }

  return (
    <div className={cn('min-h-0 flex-1 flex-col', pageVisible ? 'flex' : 'hidden')}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={!navState.canGoBack}
          aria-label={translate(
            'auto.components.pinned-web-panels.PinnedWebPanelPage.back',
            'Go back'
          )}
          onClick={() => {
            if (activePanelId !== null) {
              navigatePinnedWebPanelWebview(activePanelId, 'back')
            }
          }}
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={!navState.canGoForward}
          aria-label={translate(
            'auto.components.pinned-web-panels.PinnedWebPanelPage.forward',
            'Go forward'
          )}
          onClick={() => {
            if (activePanelId !== null) {
              navigatePinnedWebPanelWebview(activePanelId, 'forward')
            }
          }}
        >
          <ArrowRight className="size-3.5" strokeWidth={1.75} />
        </Button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">
          {activePanel?.title ?? ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={translate(
            'auto.components.pinned-web-panels.PinnedWebPanelPage.reload',
            'Reload panel'
          )}
          onClick={() => {
            if (activePanelId !== null) {
              reloadPinnedWebPanelWebview(activePanelId)
            }
          }}
        >
          <RotateCw className="size-3.5" strokeWidth={1.75} />
        </Button>
        {activePanel ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={translate(
                'auto.components.pinned-web-panels.PinnedWebPanelPage.splitRight',
                'Split right in canvas'
              )}
              title={translate(
                'auto.components.pinned-web-panels.PinnedWebPanelPage.splitRight',
                'Split right in canvas'
              )}
              onClick={() => openPanelInCanvas({ kind: 'web', panelId: activePanel.id }, 'row')}
            >
              <Columns2 className="size-3.5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={translate(
                'auto.components.pinned-web-panels.PinnedWebPanelPage.splitDown',
                'Split down in canvas'
              )}
              title={translate(
                'auto.components.pinned-web-panels.PinnedWebPanelPage.splitDown',
                'Split down in canvas'
              )}
              onClick={() => openPanelInCanvas({ kind: 'web', panelId: activePanel.id }, 'column')}
            >
              <Rows2 className="size-3.5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={translate(
                'auto.components.pinned-web-panels.PinnedWebPanelPage.detach',
                'Open in new window'
              )}
              title={translate(
                'auto.components.pinned-web-panels.PinnedWebPanelPage.detach',
                'Open in new window'
              )}
              onClick={() => detachPanelIntoWindow('web', activePanel.id, activePanel.title)}
            >
              <PictureInPicture2 className="size-3.5" strokeWidth={1.75} />
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={translate(
            'auto.components.pinned-web-panels.PinnedWebPanelPage.close',
            'Close panel'
          )}
          onClick={closePinnedWebPanelPage}
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      {visitedPanels.map((panel) => (
        <PinnedWebPanelViewport
          key={panel.id}
          panel={panel}
          visible={pageVisible && panel.id === activePanelId}
        />
      ))}
    </div>
  )
})

export default PinnedWebPanelPage
