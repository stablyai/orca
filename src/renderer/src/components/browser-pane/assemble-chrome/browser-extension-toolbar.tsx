import { useEffect, useRef } from 'react'
import { Pin, Puzzle, Settings2, Store } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  BrowserExtensionToolbarAction,
  BrowserExtensionToolbarState
} from '../../../../../shared/browser-extension-toolbar-types'
import { CHROME_WEB_STORE_HOME_URL } from '../../../../../shared/browser-extension-webstore'
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
  action,
  buttonRef
}: {
  browserPageId: string
  profileId: string
  action: BrowserExtensionToolbarAction
  buttonRef: (element: HTMLButtonElement | null) => void
}): React.JSX.Element {
  const badge = action.badgeText.slice(0, MAX_BADGE_CHARACTERS)
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              ref={buttonRef}
              size="icon"
              variant="ghost"
              className="relative h-7 w-7"
              aria-label={action.title}
              aria-disabled={!action.enabled}
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
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <ExtensionIcon action={action} />
        <span className="min-w-0 flex-1 truncate">{action.name}</span>
        {action.pinned ? <Pin className="size-3" /> : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem disabled={!action.enabled} onSelect={onOpen}>
          <ExtensionIcon action={action} />
          {translate('browser.extensions.open', 'Open')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <PuzzleRowMenuEntries browserPageId={browserPageId} profileId={profileId} action={action} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * Extension buttons in the browser chrome: pinned actions (hidden when `compact`, as the row
 * folds) and the puzzle menu listing every extension on in this page's profile.
 */
export function BrowserExtensionToolbar({
  browserPageId,
  state,
  compact
}: {
  browserPageId: string
  state: BrowserExtensionToolbarState
  compact: boolean
}): React.JSX.Element {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openBrowserProfileTab = useAppStore((s) => s.openBrowserProfileTabInActiveWorkspace)
  const puzzleRef = useRef<HTMLButtonElement>(null)
  const pinnedRefs = useRef(new Map<string, HTMLButtonElement>())
  const pinned = compact ? [] : state.actions.filter((action) => action.pinned)

  // action.openPopup and _execute_action: open under the button, or the puzzle when not pinned.
  useEffect(() => {
    const subscribe = window.api.browser?.onExtensionsPopupRequested
    if (!subscribe) {
      return
    }
    return subscribe((request) => {
      if (request.browserPageId !== browserPageId) {
        return
      }
      const anchor = pinnedRefs.current.get(request.extensionId) ?? puzzleRef.current
      activate(browserPageId, request.extensionId, anchor, true)
    })
  }, [browserPageId])

  const label = translate('browser.extensions.menu', 'Extensions')
  return (
    <>
      {pinned.map((action) => (
        <PinnedActionButton
          key={action.extensionId}
          browserPageId={browserPageId}
          profileId={state.profileId}
          action={action}
          buttonRef={(element) => {
            if (element) {
              pinnedRefs.current.set(action.extensionId, element)
            } else {
              pinnedRefs.current.delete(action.extensionId)
            }
          }}
        />
      ))}
      <DropdownMenu modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                ref={puzzleRef}
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label={label}
              >
                <Puzzle className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {label}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-64">
          {state.actions.length === 0 ? (
            <DropdownMenuItem disabled>
              {translate('browser.extensions.empty', 'No extensions are on for this profile')}
            </DropdownMenuItem>
          ) : (
            state.actions.map((action) => (
              <ExtensionMenuRow
                key={action.extensionId}
                browserPageId={browserPageId}
                profileId={state.profileId}
                action={action}
                onOpen={() =>
                  activate(
                    browserPageId,
                    action.extensionId,
                    pinnedRefs.current.get(action.extensionId) ?? puzzleRef.current
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
            {translate('browser.extensions.visitWebStore', 'Visit Chrome Web Store')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              openSettingsPage()
              openSettingsTarget({ pane: 'browser', repoId: null, sectionId: 'browser-extensions' })
            }}
          >
            <Settings2 className="size-3.5" />
            {translate('browser.extensions.manage', 'Manage extensions')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
