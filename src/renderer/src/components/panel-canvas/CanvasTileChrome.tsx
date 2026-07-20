import React from 'react'
import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  getPinnedWebPanelNavState,
  navigatePinnedWebPanelWebview,
  reloadPinnedWebPanelWebview,
  subscribePinnedWebPanelNavState
} from '@/components/pinned-web-panels/pinned-web-panel-webview'
import type { PanelSplitChoice, PanelSplitMenuItem } from '@/lib/panel-split-candidates'
import { PanelSplitMenuButtons } from './PanelSplitMenu'

/** Registry key for a canvas tile's webview — leaf-scoped so a tile never
 *  steals the guest owned by the full-page web panel view of the same panel. */
export function canvasWebviewId(leafId: string): string {
  return `canvas::${leafId}`
}

/** Per-tile header. Web tiles carry real back/forward controls (same guest
 *  history as the full-page panel view): a dashboard that navigates itself
 *  into a dead end must be recoverable inside a canvas too, not only when
 *  the panel is opened full-page. Split opens a candidate picker — never
 *  silent-clones the current tile. */
export function CanvasTileChrome({
  title,
  host,
  webviewLeafId,
  splitItems,
  onPickSplit,
  onClose,
  splitDisabled
}: {
  title: string
  host?: string
  /** Set for web/browser tiles — enables reload + history navigation. */
  webviewLeafId?: string
  splitItems: readonly PanelSplitMenuItem[]
  onPickSplit: (direction: 'row' | 'column', choice: PanelSplitChoice) => void
  onClose: () => void
  splitDisabled: boolean
}): React.JSX.Element {
  const webviewId = webviewLeafId === undefined ? null : canvasWebviewId(webviewLeafId)
  const navState = React.useSyncExternalStore(subscribePinnedWebPanelNavState, () =>
    getPinnedWebPanelNavState(webviewId)
  )
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-background/60 px-1.5">
      {webviewId !== null ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            disabled={!navState.canGoBack}
            aria-label={translate('auto.components.panel-canvas.CanvasTileChrome.back', 'Go back')}
            onClick={() => navigatePinnedWebPanelWebview(webviewId, 'back')}
          >
            <ArrowLeft className="size-3" strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            disabled={!navState.canGoForward}
            aria-label={translate(
              'auto.components.panel-canvas.CanvasTileChrome.forward',
              'Go forward'
            )}
            onClick={() => navigatePinnedWebPanelWebview(webviewId, 'forward')}
          >
            <ArrowRight className="size-3" strokeWidth={1.75} />
          </Button>
        </>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium tracking-tight">
        {title}
      </span>
      {host ? (
        <span className="shrink-0 rounded bg-muted px-1 py-px font-mono text-[9px] text-muted-foreground">
          {host}
        </span>
      ) : null}
      {webviewId !== null ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          aria-label={translate(
            'auto.components.panel-canvas.PanelCanvasPage.reloadTile',
            'Reload tile'
          )}
          onClick={() => reloadPinnedWebPanelWebview(webviewId)}
        >
          <RotateCw className="size-3" strokeWidth={1.75} />
        </Button>
      ) : null}
      <PanelSplitMenuButtons items={splitItems} disabled={splitDisabled} onPick={onPickSplit} />
      <Button
        variant="ghost"
        size="icon"
        className="size-5"
        aria-label={translate(
          'auto.components.panel-canvas.PanelCanvasPage.closeTile',
          'Close tile'
        )}
        onClick={onClose}
      >
        <X className="size-3" strokeWidth={1.75} />
      </Button>
    </div>
  )
}
