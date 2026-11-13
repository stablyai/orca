import { useEffect } from 'react'
import { Pin, Puzzle, Settings2, Store } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import type {
  BrowserExtensionToolbarAction,
  BrowserExtensionToolbarState
} from '../../../../../shared/browser/extensions/browser-extension-toolbar-types'
import { CHROME_WEB_STORE_HOME_URL } from '../../../../../shared/browser/extensions/browser-extension-webstore'
import {
  BrowserExtensionContextEntries,
  BrowserExtensionDropdownEntries,
  useBrowserExtensionActionMenuEntries
} from './browser-extension-action-menu'

/** Chrome shows at most four badge characters. */
const MAX_BADGE_CHARACTERS = 4

function activate(
  browserPageId: string,
  extensionId: string,
  anchor: HTMLElement | null,
  popupOnly = false
): void {
  if (!anchor) {
    return
  }
  const { x, y, width, height } = anchor.getBoundingClientRect()
  void window.api.browser
    .extensionsActivateAction({
      browserPageId,
      extensionId,
      anchor: { x, y, width, height },
      popupOnly
    })
    .then((result) => {
      if (!result.ok) {
        toast.error(result.error)
      }
    })
}

function pinnedButtonKey(browserPageId: string, extensionId: string): string {
  return `${browserPageId}:${extensionId}`
}

// Why a DOM lookup: the ⋯ menu and the pinned row are separate subtrees, and the DOM already
// tracks which pinned buttons are mounted (none while compact) without a registry to keep in sync.
function findPinnedButton(browserPageId: string, extensionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-browser-extension-pinned="${CSS.escape(pinnedButtonKey(browserPageId, extensionId))}"]`
  )
}

function ExtensionIcon({ action }: { action: BrowserExtensionToolbarAction }): React.JSX.Element {
  return action.iconDataUrl ? (
    <img
      src={action.iconDataUrl}
      alt=""
      className={cn('size-4 shrink-0', !action.enabled && 'opacity-40 grayscale')}
    />
  ) : (
    <Puzzle className="size-4 shrink-0 text-muted-foreground" />
  )
}

type ActionMenuProps = {
  browserPageId: string
  profileId: string
  action: BrowserExtensionToolbarAction
}

// Why separate components: they mount with the open menu, which is when the extension's items are fetched.
function PinnedActionMenuEntries(props: ActionMenuProps): React.JSX.Element {
  const entries = useBrowserExtensionActionMenuEntries(
    props.profileId,
    props.action,
    props.browserPageId
  )
  return <BrowserExtensionContextEntries entries={entries} />
}

function PuzzleRowMenuEntries(props: ActionMenuProps): React.JSX.Element {
  const entries = useBrowserExtensionActionMenuEntries(
    props.profileId,
    props.action,
    props.browserPageId
  )
  return <BrowserExtensionDropdownEntries entries={entries} />
}

function PinnedActionButton({
  browserPageId,
  profileId,
  action
}: ActionMenuProps): React.JSX.Element {
  const badge = action.badgeText.slice(0, MAX_BADGE_CHARACTERS)
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="relative h-7 w-7"
              aria-label={action.title}
              aria-disabled={!action.enabled}
              data-browser-extension-pinned={pinnedButtonKey(browserPageId, action.extensionId)}
              onClick={(event) => activate(browserPageId, action.extensionId, event.currentTarget)}
            >
              <ExtensionIcon action={action} />
              {badge ? (
                <span
                  className="pointer-events-none absolute right-0 bottom-0.5 min-w-3 rounded-sm bg-primary px-0.5 text-center text-3xs leading-3 font-medium text-primary-foreground"
                  // Why inline: the colours are the extension's own, set at runtime.
                  style={{
                    ...(action.badgeBackgroundColor
                      ? { backgroundColor: action.badgeBackgroundColor }
                      : {}),
                    ...(action.badgeTextColor ? { color: action.badgeTextColor } : {})
                  }}
                >
                  {badge}
                </span>
              ) : null}
            </Button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {action.title}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <PinnedActionMenuEntries
          browserPageId={browserPageId}
          profileId={profileId}
          action={action}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ExtensionMenuRow({
  browserPageId,
  profileId,
  action,
  onOpen
}: ActionMenuProps & { onOpen: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <ExtensionIcon action={action} />
        <span className="min-w-0 flex-1 truncate">{action.name}</span>
        {action.pinned ? <Pin className="size-3" /> : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent data-browser-page-menu-id={browserPageId}>
        <DropdownMenuItem disabled={!action.enabled} onSelect={onOpen}>
          <ExtensionIcon action={action} />
          {t('browser.extensions.open', 'Open')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <PuzzleRowMenuEntries browserPageId={browserPageId} profileId={profileId} action={action} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * Pinned extension buttons in the browser chrome (none when `compact`, as the row folds). Stays
 * mounted while the page toolbar is, so popups the extension opens itself still find an anchor.
 */
export function BrowserExtensionToolbar({
  browserPageId,
  state,
  compact,
  fallbackAnchorRef
}: {
  browserPageId: string
  state: BrowserExtensionToolbarState
  compact: boolean
  fallbackAnchorRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const pinned = compact ? [] : state.actions.filter((action) => action.pinned)

  // action.openPopup and _execute_action: open under the button, or the ⋯ menu when not pinned.
  useEffect(() => {
    const subscribe = window.api.browser?.onExtensionsPopupRequested
    if (!subscribe) {
      return
    }
    return subscribe((request) => {
      if (request.browserPageId !== browserPageId) {
        return
      }
      const anchor =
        findPinnedButton(browserPageId, request.extensionId) ?? fallbackAnchorRef.current
      activate(browserPageId, request.extensionId, anchor, true)
    })
  }, [browserPageId, fallbackAnchorRef])

  return (
    <>
      {pinned.map((action) => (
        <PinnedActionButton
          key={action.extensionId}
          browserPageId={browserPageId}
          profileId={state.profileId}
          action={action}
        />
      ))}
    </>
  )
}

/** The "Extensions" submenu of the ⋯ browser menu: every extension on in this page's profile. */
export function BrowserExtensionsMenuSub({
  browserPageId,
  state,
  anchorRef,
  deferUntilClose
}: {
  browserPageId: string
  state: BrowserExtensionToolbarState
  anchorRef: React.RefObject<HTMLButtonElement | null>
  deferUntilClose: (action: () => void) => void
}): React.JSX.Element {
  const t = useTranslate()
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openBrowserProfileTab = useAppStore((s) => s.openBrowserProfileTabInActiveWorkspace)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (open) {
          void recordFeatureInteraction('browser-extensions')
        }
      }}
    >
      <DropdownMenuSubTrigger>
        <Puzzle className="mr-2 size-3.5" />
        {t('browser.extensions.menu', 'Extensions')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64" data-browser-page-menu-id={browserPageId}>
        {state.actions.length === 0 ? (
          <DropdownMenuItem disabled>
            {t('browser.extensions.empty', 'No extensions are on for this profile')}
          </DropdownMenuItem>
        ) : (
          state.actions.map((action) => (
            <ExtensionMenuRow
              key={action.extensionId}
              browserPageId={browserPageId}
              profileId={state.profileId}
              action={action}
              onOpen={() =>
                // Why defer: the popup must not open while the menu is still closing over it.
                deferUntilClose(() =>
                  activate(
                    browserPageId,
                    action.extensionId,
                    findPinnedButton(browserPageId, action.extensionId) ?? anchorRef.current
                  )
                )
              }
            />
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          // Why this profile: an install from the store page lands where the store was opened.
          onSelect={() => void openBrowserProfileTab(CHROME_WEB_STORE_HOME_URL, state.profileId)}
        >
          <Store className="size-3.5" />
          {t('browser.extensions.visitWebStore', 'Visit Chrome Web Store')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            openSettingsPage()
            openSettingsTarget({ pane: 'browser', repoId: null, sectionId: 'browser-extensions' })
          }}
        >
          <Settings2 className="size-3.5" />
          {t('browser.extensions.manage', 'Manage extensions')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
