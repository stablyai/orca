import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import BrowserAddressBar from './BrowserAddressBar'
import {
  BrowserChromeToolbar,
  type BrowserChromeElementTools,
  type BrowserChromeMarkupTool
} from './browser-chrome-toolbar'
import { RemoteRuntimeEgressIndicator } from './browser-egress-indicator'
import type { BrowserNavigationControls } from './browser-navigation-control-row'
import type { BrowserAddressBarEditSessionBinding } from './use-browser-address-bar-edit-session'

/** Binds the shared browser chrome to a client-hosted page: rendered here, browsing through a remote host. */
export function ClientHostedBrowserPageToolbar({
  browserPageId,
  runtimeEnvironmentId,
  controls,
  addressBarValue,
  onAddressBarChange,
  addressBarInputRef,
  addressBarEditSession,
  reloadLabel,
  elementTools,
  markup
}: {
  browserPageId: string
  runtimeEnvironmentId: string
  controls: BrowserNavigationControls
  addressBarValue: string
  onAddressBarChange: (value: string) => void
  addressBarInputRef: React.RefObject<HTMLInputElement | null>
  addressBarEditSession: BrowserAddressBarEditSessionBinding
  reloadLabel: string
  elementTools: BrowserChromeElementTools
  markup: BrowserChromeMarkupTool
}): React.JSX.Element {
  return (
    <BrowserChromeToolbar
      controls={controls}
      addressSlot={
        <BrowserAddressBar
          value={addressBarValue}
          onChange={onAddressBarChange}
          onSubmit={() => controls.navigate(addressBarValue)}
          onNavigate={controls.navigate}
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
      reloadLabel={reloadLabel}
      elementTools={elementTools}
      markup={markup}
      // Why null: a page URL may only resolve through the remote host's network (loopback names the
      // host), so a local default browser could open the wrong machine.
      viewSource={null}
      openExternal={null}
    />
  )
}
