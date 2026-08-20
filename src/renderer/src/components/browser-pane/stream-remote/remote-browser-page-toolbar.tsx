import { ArrowLeft, ArrowRight, Loader2, MessageSquarePlus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import BrowserAddressBar from '../assemble-chrome/BrowserAddressBar'
import { MarkupDrawButton } from '../annotate/MarkupDrawButton'
import type { MarkupModeController } from '../annotate/useMarkupMode'

export function RemoteBrowserPageToolbar({
  addressBarValue,
  onAddressBarChange,
  onSubmitAddressBar,
  onNavigateToUrl,
  addressBarInputRef,
  busy,
  loading,
  markup,
  frameUrl,
  isActive,
  onBack,
  onForward,
  onReload
}: {
  addressBarValue: string
  onAddressBarChange: (value: string) => void
  onSubmitAddressBar: () => void
  onNavigateToUrl: (url: string) => void
  addressBarInputRef: React.RefObject<HTMLInputElement | null>
  busy: boolean
  loading: boolean
  markup: MarkupModeController
  frameUrl: string | null
  isActive: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
}): React.JSX.Element {
  return (
    <div
      className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5"
      data-contextual-tour-target="browser-toolbar"
    >
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onBack}>
        <ArrowLeft className="size-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onForward}>
        <ArrowRight className="size-4" />
      </Button>
      {/* Why: no ignore-cache RPC exists for remote pages, and this pane binds no reload chord, so there is
          nothing truthful to put in a menu or a shortcut hint here — tooltip only. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
            onClick={onReload}
          >
            {busy || loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
        </TooltipContent>
      </Tooltip>
      <BrowserAddressBar
        value={addressBarValue}
        onChange={onAddressBarChange}
        onSubmit={onSubmitAddressBar}
        onNavigate={onNavigateToUrl}
        inputRef={addressBarInputRef}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 opacity-50"
            aria-disabled="true"
            aria-label={translate(
              'auto.components.browser.pane.BrowserPane.deb5293610',
              'Browser annotations unavailable in remote runtime'
            )}
            onClick={(event) => {
              event.preventDefault()
            }}
          >
            <MessageSquarePlus className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate(
            'auto.components.browser.pane.BrowserPane.8b7e6d1f5a',
            'Browser annotations are only available in local browser tabs.'
          )}
        </TooltipContent>
      </Tooltip>
      <MarkupDrawButton
        onClick={() => (markup.isActive ? markup.cancel() : void markup.start())}
        disabled={!frameUrl}
        active={markup.isActive}
        surfaceActive={isActive}
        className="h-7 w-7"
      />
    </div>
  )
}
