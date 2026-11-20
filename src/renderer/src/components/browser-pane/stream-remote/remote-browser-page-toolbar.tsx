import { useState } from 'react'
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
import { BrowserReloadControl } from '../assemble-chrome/toolbar/browser-reload-control'
import { useBrowserReloadControlLabels } from '../navigate/use-browser-reload-control-labels'
import {
  type BrowserReloadTrigger,
  resolveBrowserReloadIntent
} from '../navigate/browser-reload-action'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { BROWSER_STOP_HARD_RELOAD_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'

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
  loadErrorCode,
  markup,
  frameUrl,
  isActive,
  history,
  onBack,
  onForward,
  onReload,
  onStop
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
  loadErrorCode: number | null
  markup: MarkupModeController
  frameUrl: string | null
  isActive: boolean
  history: { canGoBack: boolean; canGoForward: boolean }
  onBack: () => void
  onForward: () => void
  onReload: (ignoreCache: boolean) => void
  onStop: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // Older hosts have no stop and reload normally either way, so they keep the plain button.
  const stopHardReloadSupported = useRuntimeEnvironmentCapability(
    runtimeEnvironmentId,
    BROWSER_STOP_HARD_RELOAD_RUNTIME_CAPABILITY
  )
  const reloadState = { loading, loadErrorCode }
  const reloadLabels = useBrowserReloadControlLabels(reloadState)
  const [reloadMenuOpen, setReloadMenuOpen] = useState(false)
  const runReloadTrigger = (trigger: BrowserReloadTrigger): void => {
    const intent = resolveBrowserReloadIntent(trigger, reloadState)
    // A failed host page has no local guest to recover, so Retry is a plain reload.
    if (intent === 'stop') {
      onStop()
    } else {
      onReload(intent === 'hard-reload')
    }
  }
  return (
    <BrowserNavigationControlRow
      controls={{
        canGoBack: history.canGoBack,
        canGoForward: history.canGoForward,
        goBack: onBack,
        goForward: onForward,
        reload: () => onReload(false),
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
          loadFailed={loadErrorCode !== null}
        />
      }
      reloadControl={
        stopHardReloadSupported ? (
          <BrowserReloadControl
            menuOpen={reloadMenuOpen}
            onMenuOpenChange={setReloadMenuOpen}
            label={reloadLabels.reloadButtonLabel}
            showStop={reloadLabels.reloadButtonLabelKind === 'stop'}
            showShortcutHint={reloadLabels.reloadButtonLabelKind === 'reload'}
            reloadShortcut={reloadLabels.reloadShortcut}
            hardReloadShortcut={reloadLabels.hardReloadShortcut}
            onPrimary={() => runReloadTrigger('button')}
            onReload={() => runReloadTrigger('reload')}
            onHardReload={() => runReloadTrigger('hard-reload')}
          />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="muted-field-icon"
                aria-label={t('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
                onClick={() => onReload(false)}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {t('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
            </TooltipContent>
          </Tooltip>
        )
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
