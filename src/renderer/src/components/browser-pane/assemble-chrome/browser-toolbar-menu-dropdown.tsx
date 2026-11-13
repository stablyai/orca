import {
  Ellipsis,
  ExternalLink,
  History,
  Monitor,
  RotateCcw,
  Search,
  Settings,
  SquareCode
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { formatOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import type {
  BrowserPageSiteDisplay,
  BrowserSiteColorScheme
} from '../../../../../shared/browser-site-display'
import type { BrowserPageZoomDirection } from '../../../../../shared/browser-page-zoom'
import { BROWSER_VIEWPORT_PRESETS } from '../../../../../shared/browser-viewport-presets'
import { browserViewportPresetLabel } from './browser-viewport-preset-label'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserChromeOverflowMenuProps } from './browser-chrome-toolbar'
import {
  BrowserToolbarAppearanceSub,
  BrowserToolbarZoomRow
} from './browser-toolbar-page-display-items'
import {
  BrowserToolbarProfileSub,
  BrowserToolbarProfileSubUnavailable,
  type BrowserToolbarProfileSubProps
} from './browser-toolbar-profile-sub'

/** Page actions that used to be toolbar buttons or hidden behind a right-click on Reload. */
export type BrowserToolbarPageActions = {
  onFind: () => void
  onHardReload: () => void
  onOpenDevTools: () => void
  /** Null when the page has no address another browser could open. */
  onOpenExternal: (() => void) | null
}

type BrowserToolbarMenuDropdownProps = {
  browserPageId: string
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  /** Null where the surface's profile cannot be switched here; a disabled entry with its reason renders instead. */
  profile: BrowserToolbarProfileSubProps | { unavailableReason: string }
  pageActions: BrowserToolbarPageActions
  /** The Extensions › submenu; null where the page's session runs no extensions. */
  extensionsSub: React.ReactNode
  viewportPresetId: BrowserViewportPresetId | null
  onApplyViewportPreset: (nextId: BrowserViewportPresetId | null) => void
  siteDisplay: BrowserPageSiteDisplay | null
  onZoomPage: (direction: BrowserPageZoomDirection) => void
  onSetSiteColorScheme: (colorScheme: BrowserSiteColorScheme | null) => void
  overflow: BrowserChromeOverflowMenuProps
}

export function BrowserToolbarMenuDropdown({
  browserPageId,
  menuOpen,
  onMenuOpenChange,
  profile,
  pageActions,
  extensionsSub,
  viewportPresetId,
  onApplyViewportPreset,
  siteDisplay,
  onZoomPage,
  onSetSiteColorScheme,
  overflow
}: BrowserToolbarMenuDropdownProps): React.JSX.Element {
  const t = useTranslate()
  const keybindings = useAppStore((s) => s.keybindings)
  const historyShortcut = formatOptionalShortcutLabel('browser.showHistory', keybindings)
  const findShortcut = formatOptionalShortcutLabel('browser.find', keybindings)
  const hardReloadShortcut = formatOptionalShortcutLabel('browser.hardReload', keybindings)
  const menuLabel = t('auto.components.browser.pane.BrowserToolbarMenu.7b838540c7', 'Browser menu')
  return (
    <DropdownMenu modal={false} open={menuOpen} onOpenChange={onMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={overflow.triggerRef}
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={menuLabel}
          aria-label={menuLabel}
        >
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-60"
        data-browser-page-menu-id={browserPageId}
        onCloseAutoFocus={overflow.onMenuCloseAutoFocus}
      >
        <DropdownMenuItem
          // Why deferred: focus returning to the ⋯ trigger would pull it out of the find field.
          onSelect={() => overflow.deferUntilClose(pageActions.onFind)}
        >
          <Search className="mr-2 size-3.5" />
          {t('browser.toolbar.findOnPage', 'Find on page')}
          {findShortcut ? <DropdownMenuShortcut>{findShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <BrowserToolbarZoomRow display={siteDisplay} onZoom={onZoomPage} />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Monitor className="mr-2 size-3.5" />
            {t('auto.components.browser.pane.BrowserToolbarMenu.e5d31de1a9', 'Viewport Size')}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent data-browser-page-menu-id={browserPageId}>
              {/* Use radio semantics for viewport selection; encode null as default because Radix values must be strings. */}
              <DropdownMenuRadioGroup
                value={viewportPresetId ?? 'default'}
                onValueChange={(v) =>
                  onApplyViewportPreset(v === 'default' ? null : (v as BrowserViewportPresetId))
                }
              >
                <DropdownMenuRadioItem value="default">
                  {t('auto.components.browser.pane.BrowserToolbarMenu.ed8f54509d', 'Default')}
                </DropdownMenuRadioItem>
                <DropdownMenuSeparator />
                {BROWSER_VIEWPORT_PRESETS.map((preset) => (
                  <DropdownMenuRadioItem key={preset.id} value={preset.id}>
                    <span className="truncate">{browserViewportPresetLabel(preset, t)}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <BrowserToolbarAppearanceSub
          browserPageId={browserPageId}
          display={siteDisplay}
          onSetColorScheme={onSetSiteColorScheme}
        />

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={pageActions.onHardReload}>
          <RotateCcw className="mr-2 size-3.5" />
          {t('auto.components.browser.pane.BrowserPane.a1f3c2e4b5', 'Hard Reload')}
          {hardReloadShortcut ? (
            <DropdownMenuShortcut>{hardReloadShortcut}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={pageActions.onOpenDevTools}>
          <SquareCode className="mr-2 size-3.5" />
          {t('auto.components.browser.pane.BrowserPane.ec75d0c412', 'Open browser devtools')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!pageActions.onOpenExternal}
          onSelect={() => pageActions.onOpenExternal?.()}
        >
          <ExternalLink className="mr-2 size-3.5" />
          {t('auto.components.browser.pane.BrowserPane.0f41bf80c7', 'Open in default browser')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {extensionsSub}
        {'unavailableReason' in profile ? (
          <BrowserToolbarProfileSubUnavailable reason={profile.unavailableReason} />
        ) : (
          <BrowserToolbarProfileSub {...profile} />
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          // Why deferred: focus returning to the ⋯ trigger would otherwise close the dialog at once.
          onSelect={() =>
            overflow.deferUntilClose(() =>
              useAppStore.getState().setBrowserHistoryPageId(browserPageId)
            )
          }
        >
          <History className="mr-2 size-3.5" />
          {t('browser.history.menuItem', 'History')}
          {historyShortcut ? <DropdownMenuShortcut>{historyShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            useAppStore.getState().openSettingsTarget({ pane: 'browser', repoId: null })
            useAppStore.getState().openSettingsPage()
          }}
        >
          <Settings className="mr-2 size-3.5" />
          {t('auto.components.browser.pane.BrowserToolbarMenu.a771c2b6c8', 'Browser Settings…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
