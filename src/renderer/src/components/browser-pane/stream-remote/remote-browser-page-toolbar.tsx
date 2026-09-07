import { Loader2, MessageSquarePlus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { BrowserNavigationControlRow } from '../assemble-chrome/browser-navigation-control-row'
import BrowserAddressBar from '../assemble-chrome/BrowserAddressBar'
import type { BrowserAddressBarEditSessionBinding } from '../assemble-chrome/use-browser-address-bar-edit-session'
import type { BrowserPageDocLocation } from '../../../../../shared/browser-workspace-types'
import { RemoteRuntimeEgressIndicator } from '../assemble-chrome/browser-egress-indicator'
import { MarkupDrawButton } from '../annotate/MarkupDrawButton'
import type { MarkupModeController } from '../annotate/useMarkupMode'

export function RemoteBrowserPageToolbar({
  runtimeEnvironmentId,
  addressBarValue,
  onAddressBarChange,
  onSubmitAddressBar,
  onNavigateToUrl,
  onOpenWorkspaceDoc,
  addressBarInputRef,
  addressBarEditSession,
  busy,
  loading,
  markup,
  frameUrl,
  isActive,
  onBack,
  onForward,
  onReload
}: {
  runtimeEnvironmentId: string
  addressBarValue: string
  onAddressBarChange: (value: string) => void
  onSubmitAddressBar: () => void
  onNavigateToUrl: (url: string) => void
  /** A previewed-document suggestion opens on a fresh grant instead of navigating the remote guest. */
  onOpenWorkspaceDoc: (docLocation: BrowserPageDocLocation) => void
  addressBarInputRef: React.RefObject<HTMLInputElement | null>
  addressBarEditSession: BrowserAddressBarEditSessionBinding
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
    <BrowserNavigationControlRow
      controls={{
        // Why: remote pages report no history depth, so the arrows stay live and a
        // dead-end back/forward RPC is simply a no-op on the host.
        canGoBack: true,
        canGoForward: true,
        loading: busy || loading,
        goBack: onBack,
        goForward: onForward,
        reload: onReload,
        navigate: onNavigateToUrl
      }}
      addressSlot={
        <BrowserAddressBar
          value={addressBarValue}
          onChange={onAddressBarChange}
          onSubmit={onSubmitAddressBar}
          onNavigate={onNavigateToUrl}
          onOpenWorkspaceDoc={onOpenWorkspaceDoc}
          inputRef={addressBarInputRef}
          editSession={addressBarEditSession}
          leadingIcon={
            <RemoteRuntimeEgressIndicator
              runtimeEnvironmentId={runtimeEnvironmentId}
              presentation="streamed"
            />
          }
        />
      }
      reloadControl={
        // Why: no ignore-cache RPC exists for remote pages, and this pane binds no reload chord, so there is
        // nothing truthful to put in a menu or a shortcut hint here — tooltip only.
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={translate(
                'auto.components.browser.pane.BrowserPane.0e080d820e',
                'Reload'
              )}
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
      }
    >
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
    </BrowserNavigationControlRow>
  )
}
