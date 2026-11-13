import { useCallback, useRef } from 'react'
import { Puzzle } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { BrowserToolbarMenu } from './BrowserToolbarMenu'
import { destroyPersistentWebview } from '../host-guest/webview-registry'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'

/** The client-hosted surface's Extensions placeholder until the shared extension toolbar hook reaches this pane. */
function ClientHostedExtensionsUnavailable(): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem disabled aria-disabled="true">
      <Puzzle className="mr-2 size-3.5" />
      <span className="min-w-0">
        <span className="block">{t('browser.toolbar.extensions', 'Extensions')}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {t(
            'browser.toolbar.extensionsClientHostedUnavailable',
            'Not available on pages hosted by this desktop yet.'
          )}
        </span>
      </span>
    </DropdownMenuItem>
  )
}

/** Client-hosted pages of remote workspaces share the server toolbar's ⋯ menu; its actions route by page id. */
export function ClientHostedBrowserOverflowMenu({
  browserTab,
  sessionProfileId,
  workspaceId,
  isActive,
  onOpenFind,
  onHardReload
}: {
  browserTab: BrowserPage
  /** The workspace's active browser profile, for the menu's label only here; switching cannot rebuild this surface's guest yet. */
  sessionProfileId: string | null
  workspaceId: string
  isActive: boolean
  onOpenFind: () => void
  onHardReload: () => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const t = useTranslate()
  // The extensions submenu is the only defer-until-close consumer; standalone rows run actions after close.
  const deferUntilClose = useCallback((action: () => void) => {
    window.setTimeout(action, 0)
  }, [])
  const onMenuCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault()
  }, [])
  const blank = isBlankBrowserUrl(browserTab.url)
  return (
    <BrowserToolbarMenu
      currentProfileId={sessionProfileId}
      workspaceId={workspaceId}
      browserPageId={browserTab.id}
      viewportPresetId={browserTab.viewportPresetId ?? null}
      onDestroyWebview={() => void destroyPersistentWebview(browserTab.id)}
      isActive={isActive}
      isBlankTab={blank}
      pageActions={{
        onFind: onOpenFind,
        onHardReload,
        onOpenDevTools: () => void window.api.browser.openDevTools({ browserPageId: browserTab.id }),
        onOpenExternal: blank ? null : () => void window.api.shell.openUrl(browserTab.url)
      }}
      extensionsSub={<ClientHostedExtensionsUnavailable />}
      profileUnavailableReason={t(
        'browser.toolbar.profileClientHostedUnavailable',
        'Profile changes must rebuild this desktop-hosted page; not wired yet.'
      )}
      overflow={{ triggerRef, deferUntilClose, onMenuCloseAutoFocus }}
    />
  )
}
