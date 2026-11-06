import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PanelBottom, PanelRight, SquareArrowOutUpRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { ResizeHandle } from '@/components/tab-group/TabGroupSplitNodeTree'
import { browserDevToolsDockFraction } from '../../../../../shared/browser-devtools-dock'
import { acquireWebviewsDragPassthrough } from '../host-guest/webview-drag-passthrough'
import { useBrowserDevToolsDockBounds } from './use-browser-devtools-dock-bounds'
import { useBrowserDevToolsDockPageFlex } from './browser-devtools-docked-pages'

function DockAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Divider and DevTools area. Render them right after the page box, whose flex comes from
 *  `useBrowserDevToolsDockPageFlex`, inside a `BROWSER_DEVTOOLS_DOCK_SPLIT_CLASS_NAME` box. */
export function BrowserDevToolsDock({
  browserPageId
}: {
  browserPageId: string
}): React.JSX.Element {
  const layout = useAppStore((s) => s.browserDevToolsDock)
  const setLayout = useAppStore((s) => s.setBrowserDevToolsDock)
  const [placeholder, setPlaceholder] = useState<HTMLDivElement | null>(null)
  const snapshot = useBrowserDevToolsDockBounds(browserPageId, placeholder)
  const onRatioChange = useCallback(
    (pageRatio: number) => {
      const current = useAppStore.getState().browserDevToolsDock
      setLayout(
        current.side === 'bottom'
          ? { ...current, bottomFraction: 1 - pageRatio }
          : { ...current, rightFraction: 1 - pageRatio }
      )
    },
    [setLayout]
  )
  // Pages would swallow the drag, and the native DevTools view can't take part in it.
  const releaseDragRef = useRef<(() => void) | null>(null)
  const onResizeStart = useCallback(() => {
    releaseDragRef.current?.()
    releaseDragRef.current = acquireWebviewsDragPassthrough()
  }, [])
  const onResizeEnd = useCallback(() => {
    releaseDragRef.current?.()
    releaseDragRef.current = null
  }, [])
  const nextSide = layout.side === 'bottom' ? 'right' : 'bottom'
  const title = translate('auto.components.browser.pane.BrowserPane.devToolsTitle', 'DevTools')

  return (
    <>
      <ResizeHandle
        direction={layout.side === 'bottom' ? 'vertical' : 'horizontal'}
        onResizeStart={onResizeStart}
        onResizeEnd={onResizeEnd}
        onRatioChange={onRatioChange}
      />
      <section
        data-browser-devtools-dock={layout.side}
        aria-label={title}
        className="flex min-h-0 min-w-0 flex-col bg-background"
        style={{ flex: `${browserDevToolsDockFraction(layout)} 1 0%` }}
      >
        <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border px-2">
          <span className="mr-auto truncate text-xs text-muted-foreground">{title}</span>
          <DockAction
            label={
              nextSide === 'right'
                ? translate(
                    'auto.components.browser.pane.BrowserPane.devToolsDockRight',
                    'Dock to right'
                  )
                : translate(
                    'auto.components.browser.pane.BrowserPane.devToolsDockBottom',
                    'Dock to bottom'
                  )
            }
            onClick={() => setLayout({ ...layout, side: nextSide })}
          >
            {nextSide === 'right' ? <PanelRight /> : <PanelBottom />}
          </DockAction>
          <DockAction
            label={translate(
              'auto.components.browser.pane.BrowserPane.devToolsUndock',
              'Open in separate window'
            )}
            onClick={() => void window.api.browser.openDevTools({ browserPageId, detach: true })}
          >
            <SquareArrowOutUpRight />
          </DockAction>
          <DockAction
            label={translate(
              'auto.components.browser.pane.BrowserPane.devToolsClose',
              'Close DevTools'
            )}
            onClick={() => void window.api.browser.closeDevTools({ browserPageId })}
          >
            <X />
          </DockAction>
        </div>
        <div ref={setPlaceholder} className="relative min-h-0 flex-1 overflow-hidden">
          {snapshot ? (
            <img
              alt=""
              src={snapshot.url}
              className="pointer-events-none absolute top-0 left-0 max-w-none"
              style={{ width: snapshot.width, height: snapshot.height }}
            />
          ) : null}
        </div>
      </section>
    </>
  )
}

/** Docks DevTools into a local page's DOM-built viewport, which React doesn't render. */
export function BrowserPageDevToolsDock({
  browserPageId,
  viewport
}: {
  browserPageId: string
  viewport: { container: HTMLDivElement; devToolsSplit: HTMLDivElement } | null
}): React.JSX.Element | null {
  const pageFlex = useBrowserDevToolsDockPageFlex(browserPageId)
  const container = viewport?.container ?? null
  useLayoutEffect(() => {
    if (container) {
      container.style.flex = pageFlex ?? ''
    }
  }, [container, pageFlex])
  return viewport && pageFlex !== null
    ? createPortal(<BrowserDevToolsDock browserPageId={browserPageId} />, viewport.devToolsSplit)
    : null
}
