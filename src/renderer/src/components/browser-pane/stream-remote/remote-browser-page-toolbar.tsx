import { useState } from 'react'
import { useAppStore } from '@/store/index'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { BrowserChromeToolbar } from '../assemble-chrome/toolbar/browser-chrome-toolbar'
import { BrowserToolbarMenu } from '../assemble-chrome/toolbar/BrowserToolbarMenu'
import type { BrowserPageSiteDisplaySource } from '../assemble-chrome/toolbar/browser-page-site-display-source'
import { BrowserPageStateChips } from '../assemble-chrome/address-bar/browser-address-chips'
import { getOpenableExternalUrl, toDisplayUrl } from '../describe-page/browser-page-url-display'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { resolveRemoteFailureExternalUrl } from '../../../../../shared/browser/navigation/browser-url'
import BrowserAddressBar from '../assemble-chrome/address-bar/BrowserAddressBar'
import type { BrowserAddressBarEditSessionBinding } from '../assemble-chrome/address-bar/use-browser-address-bar-edit-session'
import type {
  BrowserPage,
  BrowserPageDocLocation,
  BrowserViewportPresetId
} from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { RemoteRuntimeEgressIndicator } from '../assemble-chrome/feedback/browser-egress-indicator'
import { BrowserReloadControl } from '../assemble-chrome/toolbar/browser-reload-control'
import { useBrowserReloadControlLabels } from '../navigate/use-browser-reload-control-labels'
import {
  type BrowserReloadTrigger,
  resolveBrowserReloadIntent
} from '../navigate/browser-reload-action'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { BROWSER_STOP_HARD_RELOAD_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import type {
  BrowserChromeElementTools,
  BrowserChromeMarkupTool,
  BrowserChromeNoteActions
} from '../assemble-chrome/toolbar/browser-annotate-tool-button'

/** The local page toolbar over a page the host renders and streams, minus what the host can't do. */
export function RemoteBrowserPageToolbar({
  page,
  workspaceId,
  worktreeId,
  isActive,
  siteDisplaySource,
  runtimeEnvironmentId,
  addressBarValue,
  onAddressBarChange,
  onSubmitAddressBar,
  onNavigateToUrl,
  onOpenWorkspaceDoc,
  addressBarInputRef,
  addressBarEditSession,
  busy,
  history,
  pickerAvailable,
  annotateTools,
  onBack,
  onForward,
  onReload,
  onStop
}: {
  page: BrowserPage
  workspaceId: string
  worktreeId: string
  isActive: boolean
  /** Null on hosts that can't report the page's site zoom and color scheme. */
  siteDisplaySource: BrowserPageSiteDisplaySource | null
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
  history: { canGoBack: boolean; canGoForward: boolean }
  pickerAvailable: boolean
  annotateTools: {
    tools: BrowserChromeElementTools
    markup: BrowserChromeMarkupTool
    notes: BrowserChromeNoteActions
  }
  onBack: () => void
  onForward: () => void
  onReload: (ignoreCache: boolean) => void
  onStop: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { id: browserPageId, url: pageUrl, loading } = page
  const viewportPresetId = page.viewportPresetId ?? null
  // The stream reads the preset from the page and sizes the host's page to it.
  const applyViewportPreset = (nextId: BrowserViewportPresetId | null): void =>
    useAppStore.getState().setBrowserPageViewportPreset(browserPageId, nextId)
  const loadErrorCode = page.loadError?.code ?? null
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
  const openableUrl = getOpenableExternalUrl(pageUrl)
  // The host's loopback address would open this machine's, not the page's.
  const externalUrl = openableUrl ? resolveRemoteFailureExternalUrl(openableUrl) : null
  return (
    <BrowserChromeToolbar
      closeTabOwner={{ worktreeId, browserPageId }}
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
          trailing={
            <BrowserPageStateChips
              browserPageId={browserPageId}
              siteDisplaySource={siteDisplaySource}
              url={toDisplayUrl(pageUrl)}
              viewportPresetId={viewportPresetId}
              onApplyViewportPreset={applyViewportPreset}
              isActive={isActive}
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
      elementTools={pickerAvailable ? annotateTools.tools : null}
      markup={annotateTools.markup}
      notes={annotateTools.notes}
      // The page runs in the host's browser, whose extensions and profiles this desktop can't drive.
      extensionActions={null}
      overflowMenu={(overflow) => (
        <BrowserToolbarMenu
          currentProfileId={null}
          workspaceId={workspaceId}
          worktreeId={worktreeId}
          browserPageId={browserPageId}
          viewportPresetId={viewportPresetId}
          onApplyViewportPreset={applyViewportPreset}
          siteDisplaySource={siteDisplaySource}
          isActive={isActive}
          isBlankTab={isBlankBrowserUrl(pageUrl)}
          pageActions={{
            onFind: null,
            onHardReload: stopHardReloadSupported ? () => runReloadTrigger('hard-reload') : null,
            onOpenDevTools: null,
            onOpenExternal: externalUrl
              ? () => void openAppHttpLink(externalUrl, { worktreeId, destination: 'system' })
              : null
          }}
          extensionsSub={null}
          showProfiles={false}
          overflow={overflow}
        />
      )}
    />
  )
}
