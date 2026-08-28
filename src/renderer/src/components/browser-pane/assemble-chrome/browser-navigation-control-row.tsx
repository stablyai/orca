import { ArrowLeft, ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import BrowserAddressBar from './BrowserAddressBar'
import type { BrowserAddressBarEditSessionBinding } from './use-browser-address-bar-edit-session'

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
 * The toolbar row every browser pane shares: back, forward, reload and the address bar.
 * Panes with a richer reload affordance pass `reloadControl`; pane-specific tools
 * (annotations, downloads, find) render as trailing children.
 */
export function BrowserNavigationControlRow({
  controls,
  addressBarValue,
  onAddressBarChange,
  onSubmitAddressBar,
  addressBarInputRef,
  dismissSuggestionsRef,
  addressBarEditSession,
  reloadControl,
  reloadLabel,
  addressBarLeadingIcon,
  children
}: {
  controls: BrowserNavigationControls
  addressBarValue: string
  onAddressBarChange: (value: string) => void
  onSubmitAddressBar: () => void
  addressBarInputRef: React.RefObject<HTMLInputElement | null>
  dismissSuggestionsRef?: React.MutableRefObject<(() => void) | null>
  /** Set by panes React remounts mid-edit; see BrowserAddressBar's `editSession`. */
  addressBarEditSession?: BrowserAddressBarEditSessionBinding | null
  reloadControl?: React.ReactNode
  /** Accessible name for the default reload button, which doubles as Stop and Retry. */
  reloadLabel?: string
  /** Replaces the address bar's leading globe (e.g. the SSH egress indicator). */
  addressBarLeadingIcon?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5"
      data-contextual-tour-target="browser-toolbar"
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

      <BrowserAddressBar
        value={addressBarValue}
        onChange={onAddressBarChange}
        onSubmit={onSubmitAddressBar}
        onNavigate={controls.navigate}
        inputRef={addressBarInputRef}
        dismissSuggestionsRef={dismissSuggestionsRef}
        editSession={addressBarEditSession}
        leadingIcon={addressBarLeadingIcon}
      />

      {children}
    </div>
  )
}
