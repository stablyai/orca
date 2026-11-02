import { ArrowLeft, ArrowRight, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE,
  BROWSER_CHROME_ADDRESS_SLOT_HEIGHT_CLASS
} from './browser-chrome-address-slot'

/** Local/client-hosted panes provide webview controls; legacy streamed panes provide runtime RPCs. */
export type BrowserNavigationControls = {
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
  navigate: (url: string) => void
}

/** Share history/tool layout while the identity slot varies between editable URLs and read-only document paths. */
export function BrowserNavigationControlRow({
  controls,
  addressSlot,
  reloadControl,
  reloadLabel,
  reloadShowsStop = false,
  showTourAnchors = true,
  rowRef,
  children
}: {
  controls: BrowserNavigationControls
  /** The surface's identity widget: an editable address bar, or a read-only document chip. */
  addressSlot: React.ReactNode
  reloadControl?: React.ReactNode
  /** Accessible name for the default reload button, which doubles as Stop and Retry. */
  reloadLabel?: string
  /** Only when the default button's click stops the load, matching its Stop label. */
  reloadShowsStop?: boolean
  /** Off for surfaces the browsing tour does not cover — a second anchor would steal its steps. */
  showTourAnchors?: boolean
  rowRef?: React.Ref<HTMLDivElement>
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      ref={rowRef}
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
          {reloadShowsStop ? <X className="size-4" /> : <RefreshCw className="size-4" />}
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
