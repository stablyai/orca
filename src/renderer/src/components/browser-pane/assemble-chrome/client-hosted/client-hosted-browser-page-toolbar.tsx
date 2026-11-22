import type { RefObject } from 'react'
import { useLocalBrowserPageSiteDisplaySource } from '../toolbar/browser-page-site-display-source'
import { applyBrowserViewportPreset } from '../viewport/browser-viewport-preset-apply'
import type { BrowserPage } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { issueBrowserGuestNavigation } from '../../host-guest/metadata/browser-guest-metadata-cache'
import type { useBrowserPageReloadActions } from '../../navigate/use-browser-page-reload-actions'
import {
  getRemoteRoutedOpenableExternalUrl,
  toDisplayUrl
} from '../../describe-page/browser-page-url-display'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import '@/lib/browser/documents/file-preview'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/browser/documents/file-preview-page-conversion'
import BrowserAddressBar from '../address-bar/BrowserAddressBar'
import type { BrowserAddressBarEditSessionBinding } from '../address-bar/use-browser-address-bar-edit-session'
import { BrowserPageStateChips } from '../address-bar/browser-address-chips'
import { BrowserPasswordSaveButton } from '../../passwords/BrowserPasswordSaveButton'
import { RemoteRuntimeEgressIndicator } from '../feedback/browser-egress-indicator'
import { BrowserChromeToolbar } from '../toolbar/browser-chrome-toolbar'
import { BrowserReloadControl } from '../toolbar/browser-reload-control'
import { BrowserToolbarMenu } from '../toolbar/BrowserToolbarMenu'
import type {
  BrowserChromeElementTools,
  BrowserChromeMarkupTool,
  BrowserChromeNoteActions
} from '../toolbar/browser-annotate-tool-button'

/** The local page toolbar over a desktop-hosted page of a remote workspace, minus what its route session can't run. */
export function ClientHostedBrowserPageToolbar({
  browserTab,
  workspaceId,
  worktreeId,
  runtimeEnvironmentId,
  isActive,
  loading,
  webviewRef,
  reload,
  addressBarValue,
  setAddressBarValue,
  addressBarEditSession,
  addressBarInputRef,
  dismissAddressBarSuggestionsRef,
  navigateToUrl,
  annotateTools,
  onOpenFind
}: {
  browserTab: BrowserPage
  workspaceId: string
  worktreeId: string
  runtimeEnvironmentId: string
  isActive: boolean
  loading: boolean
  webviewRef: RefObject<Electron.WebviewTag | null>
  reload: ReturnType<typeof useBrowserPageReloadActions>
  addressBarValue: string
  setAddressBarValue: (value: string) => void
  addressBarEditSession: BrowserAddressBarEditSessionBinding
  addressBarInputRef: RefObject<HTMLInputElement | null>
  dismissAddressBarSuggestionsRef: RefObject<(() => void) | null>
  navigateToUrl: (url: string) => void
  annotateTools: {
    elementTools: BrowserChromeElementTools
    markup: BrowserChromeMarkupTool
    notes: BrowserChromeNoteActions
  }
  onOpenFind: () => void
}): React.JSX.Element {
  const browserPageId = browserTab.id
  const siteDisplaySource = useLocalBrowserPageSiteDisplaySource(browserPageId)
  const viewportPresetId = browserTab.viewportPresetId ?? null
  const externalUrl = getRemoteRoutedOpenableExternalUrl(browserTab.url)
  return (
    <BrowserChromeToolbar
      closeTabOwner={{ worktreeId, browserPageId }}
      showTourAnchors
      controls={{
        canGoBack: browserTab.canGoBack,
        canGoForward: browserTab.canGoForward,
        goBack: () =>
          issueBrowserGuestNavigation(webviewRef.current, (webview) => webview.goBack()),
        goForward: () =>
          issueBrowserGuestNavigation(webviewRef.current, (webview) => webview.goForward()),
        reload: () => reload.runReloadTrigger('button'),
        navigate: navigateToUrl
      }}
      addressSlot={
        <BrowserAddressBar
          pageId={browserPageId}
          value={addressBarValue}
          onChange={setAddressBarValue}
          onSubmit={() => navigateToUrl(addressBarValue)}
          onNavigate={navigateToUrl}
          onOpenWorkspaceDoc={(docLocation) =>
            convertBrowserPageToWorkspaceDoc(browserPageId, docLocation)
          }
          inputRef={addressBarInputRef}
          dismissSuggestionsRef={dismissAddressBarSuggestionsRef}
          editSession={addressBarEditSession}
          leadingIcon={
            <RemoteRuntimeEgressIndicator
              runtimeEnvironmentId={runtimeEnvironmentId}
              presentation="client-hosted"
            />
          }
          trailing={
            <>
              <BrowserPasswordSaveButton browserPageId={browserPageId} isActive={isActive} />
              <BrowserPageStateChips
                browserPageId={browserPageId}
                siteDisplaySource={siteDisplaySource}
                url={toDisplayUrl(browserTab.url)}
                viewportPresetId={viewportPresetId}
                isActive={isActive}
              />
            </>
          }
          loading={loading}
          loadFailed={browserTab.loadError !== null}
        />
      }
      reloadControl={
        <BrowserReloadControl
          menuOpen={reload.reloadMenuOpen}
          onMenuOpenChange={reload.setReloadMenuOpen}
          label={reload.reloadButtonLabel}
          showStop={reload.reloadButtonLabelKind === 'stop'}
          showShortcutHint={reload.reloadButtonLabelKind === 'reload'}
          reloadShortcut={reload.reloadShortcut}
          hardReloadShortcut={reload.hardReloadShortcut}
          onPrimary={() => reload.runReloadTrigger('button')}
          onReload={() => reload.runReloadTrigger('reload')}
          onHardReload={() => reload.runReloadTrigger('hard-reload')}
        />
      }
      // Extensions load only into this desktop's profile sessions, not route partitions (#35178).
      extensionActions={null}
      {...annotateTools}
      overflowMenu={(overflow) => (
        <BrowserToolbarMenu
          currentProfileId={null}
          workspaceId={workspaceId}
          worktreeId={worktreeId}
          browserPageId={browserPageId}
          viewportPresetId={viewportPresetId}
          onApplyViewportPreset={(nextId) => applyBrowserViewportPreset(browserPageId, nextId)}
          siteDisplaySource={siteDisplaySource}
          isActive={isActive}
          isBlankTab={isBlankBrowserUrl(browserTab.url)}
          pageActions={{
            onFind: onOpenFind,
            onHardReload: () => reload.runReloadTrigger('hard-reload'),
            onOpenDevTools: () => void window.api.browser.openDevTools({ browserPageId }),
            onOpenExternal: externalUrl
              ? () => void openAppHttpLink(externalUrl, { worktreeId, destination: 'system' })
              : null
          }}
          extensionsSub={null}
          // The page runs in the server's route session, not one of this desktop's profiles.
          showProfiles={false}
          overflow={overflow}
        />
      )}
    />
  )
}
