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

/**
 * Folded tools plus reload. Profile and cookie rows are left out: a client-hosted page's session
 * profile is chosen by the host, not by this desktop's profile list.
 */
function ClientHostedBrowserOverflowMenu({
  overflow,
  onReload,
  onHardReload
}: {
  overflow: BrowserChromeOverflowMenuProps
  onReload: () => void
  onHardReload: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
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
  )
}

/** Binds the shared browser chrome to a client-hosted page: rendered here, browsing through a remote host. */
export function ClientHostedBrowserPageToolbar({
  browserPageId,
  runtimeEnvironmentId,
  canGoBack,
  canGoForward,
  loading,
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
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  webviewRef: React.RefObject<Electron.WebviewTag | null>
  reload: { runReloadTrigger: (trigger: BrowserReloadTrigger) => void; reloadButtonLabel: string }
  navigate: (url: string) => void
  addressBarValue: string
  onAddressBarChange: (value: string) => void
  addressBarInputRef: React.RefObject<HTMLInputElement | null>
  addressBarEditSession: BrowserAddressBarEditSessionBinding
  elementTools: BrowserChromeElementTools
  markup: BrowserChromeMarkupTool
}): React.JSX.Element {
  const { runReloadTrigger } = reload
  const renderOverflowMenu = useCallback(
    (overflow: BrowserChromeOverflowMenuProps) => (
      <ClientHostedBrowserOverflowMenu
        overflow={overflow}
        onReload={() => runReloadTrigger('reload')}
        onHardReload={() => runReloadTrigger('hard-reload')}
      />
    ),
    [runReloadTrigger]
  )
  return (
    <BrowserChromeToolbar
      controls={{
        canGoBack,
        canGoForward,
        loading,
        goBack: () => webviewRef.current?.goBack(),
        goForward: () => webviewRef.current?.goForward(),
        reload: () => reload.runReloadTrigger('button'),
        navigate
      }}
      addressSlot={
        <BrowserAddressBar
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
      elementTools={elementTools}
      markup={markup}
      // Why null: a page URL may only resolve through the remote host's network (loopback names the
      // host), so a local default browser could open the wrong machine.
      viewSource={null}
      openExternal={null}
      overflowMenu={renderOverflowMenu}
    />
  )
}
