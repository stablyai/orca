import { ArrowLeft, ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE,
  BROWSER_CHROME_ADDRESS_SLOT_HEIGHT_CLASS
} from './browser-chrome-address-slot'

/**
 * The history/reload/navigate surface a browser backend must provide to be driven by
 * browser chrome. Local and client-hosted panes back this with a <webview>, the legacy
 * remote pane with runtime RPCs.
 */
export type BrowserNavigationControls = {
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
  navigate: (url: string) => void
}

/**
 * The toolbar row every browser surface shares: back, forward, reload, then whatever names the
 * thing on screen, then that surface's tools.
 *
 * Why the middle is a slot rather than the address bar: a web page is named by a URL you may
 * retype, a workspace document by a path you may not. Both still sit in the same place, at the
 * same size, between the same controls — so the identity widget is what varies, not the row.
 */
export function BrowserNavigationControlRow({
  controls,
  addressSlot,
  reloadControl,
  reloadLabel,
  showTourAnchors = true,
  children
}: {
  controls: BrowserNavigationControls
  /** The surface's identity widget: an editable address bar, or a read-only document chip. */
  addressSlot: React.ReactNode
  reloadControl?: React.ReactNode
  /** Accessible name for the default reload button, which doubles as Stop and Retry. */
  reloadLabel?: string
  /** Off for surfaces the browsing tour does not cover — a second anchor would steal its steps. */
  showTourAnchors?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="relative z-10 flex shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5"
      {...(showTourAnchors ? { 'data-contextual-tour-target': 'browser-toolbar' } : {})}
    >
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={controls.goBack}
        disabled={!controls.canGoBack}
        aria-label={translate('browser.navigation.back', 'Back')}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={controls.goForward}
        disabled={!controls.canGoForward}
        aria-label={translate('browser.navigation.forward', 'Forward')}
      >
        <ArrowRight className="size-4" />
      </Button>
      {reloadControl ?? (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={controls.reload}
          aria-label={reloadLabel ?? translate('browser.navigation.reload', 'Reload')}
        >
          {controls.loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>
      )}

      <div
        className={cn(
          'flex min-w-0 flex-1 items-stretch',
          BROWSER_CHROME_ADDRESS_SLOT_HEIGHT_CLASS
        )}
        {...{ [BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE]: 'true' }}
      >
        {addressSlot}
      </div>

      {children}
    </div>
  )
}
