import { RefreshCw, SquareMousePointer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { BrowserNavigationControlRow } from '../assemble-chrome/toolbar/browser-navigation-control-row'
import BrowserAddressBar from '../assemble-chrome/address-bar/BrowserAddressBar'
import type { BrowserAddressBarEditSessionBinding } from '../assemble-chrome/address-bar/use-browser-address-bar-edit-session'
import type { BrowserPageDocLocation } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { RemoteRuntimeEgressIndicator } from '../assemble-chrome/feedback/browser-egress-indicator'
import { MarkupDrawButton } from '../annotate/markup-tools/MarkupDrawButton'
import type { MarkupModeController } from '../annotate/capture/useMarkupMode'

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
  loadFailed,
  markup,
  frameUrl,
  isActive,
  history,
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
  loadFailed: boolean
  markup: MarkupModeController
  frameUrl: string | null
  isActive: boolean
  history: { canGoBack: boolean; canGoForward: boolean }
  onBack: () => void
  onForward: () => void
  onReload: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <BrowserNavigationControlRow
      controls={{
        canGoBack: history.canGoBack,
        canGoForward: history.canGoForward,
        goBack: onBack,
        goForward: onForward,
        reload: onReload,
        navigate: onNavigateToUrl
      }}
      addressSlot={
        <BrowserAddressBar
          pageId={addressBarEditSession.pageId}
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
          loading={busy || loading}
          loadFailed={loadFailed}
        />
      }
      reloadControl={
        // Remote reload chords share browser.reload; no ignore-cache RPC exists to offer a distinct hard-reload menu action.
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="muted-field-icon"
              aria-label={t('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
              onClick={onReload}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {t('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
          </TooltipContent>
        </Tooltip>
      }
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs"
            variant="muted-field-icon"
            aria-disabled="true"
            aria-label={t(
              'auto.components.browser.pane.BrowserPane.deb5293610',
              'Browser annotations unavailable in remote runtime'
            )}
            onClick={(event) => {
              event.preventDefault()
            }}
          >
            <SquareMousePointer className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t(
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
      />
    </BrowserNavigationControlRow>
  )
}
