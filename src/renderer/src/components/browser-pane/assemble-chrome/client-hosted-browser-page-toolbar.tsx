import { useClientHostedBrowserProfiles } from './use-client-hosted-browser-profiles'
import { useAppStore } from '@/store'
import { BrowserViewportPresetMenu } from './browser-viewport-preset-menu'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import { useCallback } from 'react'
import { MoreHorizontal, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import BrowserAddressBar from './BrowserAddressBar'
import {
  BrowserChromeFoldedMenuItems,
  type BrowserChromeOverflowMenuProps
} from './browser-chrome-folded-tools'
import {
  BrowserChromeToolbar,
  type BrowserChromeElementTools,
  type BrowserChromeMarkupTool
} from './browser-chrome-toolbar'
import { RemoteRuntimeEgressIndicator } from './browser-egress-indicator'
import type { BrowserReloadTrigger } from '../navigate/browser-reload-action'
import type { BrowserAddressBarEditSessionBinding } from './use-browser-address-bar-edit-session'

/** Uses the owning runtime for profiles; cookie import remains out of scope. */
function ClientHostedBrowserOverflowMenu({
  overflow,
  runtimeEnvironmentId,
  remotePageId,
  onReload,
  onHardReload,
  viewportPresetId,
  onApplyViewportPreset
}: {
  overflow: BrowserChromeOverflowMenuProps
  runtimeEnvironmentId: string
  remotePageId: string | null
  onReload: () => void
  onHardReload: () => void
  viewportPresetId: BrowserViewportPresetId | null
  onApplyViewportPreset: (id: BrowserViewportPresetId | null) => void
}): React.JSX.Element {
  const profiles = useClientHostedBrowserProfiles(runtimeEnvironmentId, remotePageId)
  return (
    <>
      <DropdownMenu
        modal={false}
        onOpenChange={(open) => {
          if (open) {
            void profiles.load()
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            ref={overflow.triggerRef}
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={translate(
              'auto.components.browser.pane.BrowserToolbarMenu.7b838540c7',
              'Browser menu'
            )}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={overflow.onMenuCloseAutoFocus}>
          <BrowserChromeFoldedMenuItems
            tools={overflow.tools}
            deferUntilClose={overflow.deferUntilClose}
          />
          {profiles.items}
          <BrowserViewportPresetMenu
            viewportPresetId={viewportPresetId}
            onApplyViewportPreset={onApplyViewportPreset}
          />
          <DropdownMenuItem onSelect={onReload}>
            <RefreshCw className="size-3.5" />
            {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onHardReload}>
            <RotateCcw className="size-3.5" />
            {translate('auto.components.browser.pane.BrowserPane.a1f3c2e4b5', 'Hard Reload')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {profiles.dialog}
    </>
  )
}

/** Binds the shared browser chrome to a client-hosted page: rendered here, browsing through a remote host. */
export function ClientHostedBrowserPageToolbar({
  browserPageId,
  runtimeEnvironmentId,
  viewportPresetId,
  canGoBack,
  canGoForward,
  loading,
  loadFailed,
  webviewRef,
  reload,
  navigate,
  addressBarValue,
  onAddressBarChange,
  addressBarInputRef,
  addressBarEditSession,
  elementTools,
  markup
}: {
  browserPageId: string
  runtimeEnvironmentId: string
  viewportPresetId: BrowserViewportPresetId | null
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  loadFailed: boolean
  webviewRef: React.RefObject<Electron.WebviewTag | null>
  reload: {
    runReloadTrigger: (trigger: BrowserReloadTrigger) => void
    reloadButtonLabel: string
    reloadButtonLabelKind: string
  }
  navigate: (url: string) => void
  addressBarValue: string
  onAddressBarChange: (value: string) => void
  addressBarInputRef: React.RefObject<HTMLInputElement | null>
  addressBarEditSession: BrowserAddressBarEditSessionBinding
  elementTools: BrowserChromeElementTools
  markup: BrowserChromeMarkupTool
}): React.JSX.Element {
  const handle = useAppStore((state) => state.remoteBrowserPageHandlesByPageId[browserPageId])
  const remotePageId =
    handle?.environmentId === runtimeEnvironmentId && handle.placement?.kind === 'client'
      ? handle.remotePageId
      : null
  const { runReloadTrigger } = reload
  const onApplyViewportPreset = useCallback(
    (id: BrowserViewportPresetId | null) => {
      useAppStore.getState().setBrowserPageViewportPreset(browserPageId, id)
    },
    [browserPageId]
  )
  const renderOverflowMenu = useCallback(
    (overflow: BrowserChromeOverflowMenuProps) => (
      <ClientHostedBrowserOverflowMenu
        key={`${runtimeEnvironmentId}:${remotePageId ?? 'pending'}`}
        runtimeEnvironmentId={runtimeEnvironmentId}
        remotePageId={remotePageId}
        overflow={overflow}
        viewportPresetId={viewportPresetId}
        onApplyViewportPreset={onApplyViewportPreset}
        onReload={() => runReloadTrigger('reload')}
        onHardReload={() => runReloadTrigger('hard-reload')}
      />
    ),
    [runReloadTrigger, viewportPresetId, onApplyViewportPreset, runtimeEnvironmentId, remotePageId]
  )
  return (
    <BrowserChromeToolbar
      controls={{
        canGoBack,
        canGoForward,
        goBack: () => webviewRef.current?.goBack(),
        goForward: () => webviewRef.current?.goForward(),
        reload: () => reload.runReloadTrigger('button'),
        navigate
      }}
      addressSlot={
        <BrowserAddressBar
          pageId={browserPageId}
          loading={loading}
          loadFailed={loadFailed}
          value={addressBarValue}
          onChange={onAddressBarChange}
          onSubmit={() => navigate(addressBarValue)}
          onNavigate={navigate}
          onOpenWorkspaceDoc={(docLocation) =>
            convertBrowserPageToWorkspaceDoc(browserPageId, docLocation)
          }
          inputRef={addressBarInputRef}
          editSession={addressBarEditSession}
          leadingIcon={
            <RemoteRuntimeEgressIndicator
              runtimeEnvironmentId={runtimeEnvironmentId}
              presentation="client-hosted"
            />
          }
        />
      }
      reloadLabel={reload.reloadButtonLabel}
      reloadShowsStop={reload.reloadButtonLabelKind === 'stop'}
      elementTools={elementTools}
      markup={markup}
      viewSource={{
        onSelect: () => void window.api.browser.openDevTools({ browserPageId }),
        label: translate(
          'auto.components.browser.pane.BrowserPane.ec75d0c412',
          'Open browser devtools'
        )
      }}
      // Why null: loopback and host-only URLs could open the wrong machine in a local default browser.
      openExternal={null}
      overflowMenu={renderOverflowMenu}
    />
  )
}
