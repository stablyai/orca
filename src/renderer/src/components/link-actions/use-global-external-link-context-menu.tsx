import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import { resolveNativeChatHttpLinkRouting } from '@/components/native-chat/native-chat-link-target-actions'
import { useAppStore } from '@/store'
import { ExternalLinkMenuItems } from './ExternalLinkMenuItems'
import type { ExternalLinkMenuTarget } from './external-link-menu-model'
import {
  decodeLinkSourceOwner,
  LINK_OWNER_ATTRIBUTE,
  LINK_WORKTREE_ATTRIBUTE
} from './link-source-attributes'
import { parseHttpUrl } from '../../../../shared/external-browser-types'

/** Marks a PR/issue control that opens a URL from onClick so right-click offers the link menu. */
const EXTERNAL_URL_ATTRIBUTE = 'data-orca-external-url'

type GlobalExternalLinkMenu = {
  target: ExternalLinkMenuTarget
  point: { x: number; y: number }
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target
  }
  return target instanceof Node ? target.parentElement : null
}

function isInsideEditable(element: Element): boolean {
  return (
    element.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null
  )
}

/** The link's own owner and workspace; null when it is unknown, which left-click also refuses. */
function linkMenuTarget(link: Element, url: string): ExternalLinkMenuTarget | null {
  const source = link.closest(`[${LINK_OWNER_ATTRIBUTE}], [${LINK_WORKTREE_ATTRIBUTE}]`)
  const worktreeId = source?.getAttribute(LINK_WORKTREE_ATTRIBUTE) || null
  const publishedOwner = source?.getAttribute(LINK_OWNER_ATTRIBUTE)
  if (publishedOwner != null) {
    const sourceOwner = decodeLinkSourceOwner(publishedOwner)
    // Preview left-clicks never route a remote owner into Orca's browser.
    return sourceOwner.kind === 'unknown'
      ? null
      : { url, worktreeId, sourceOwner, canOpenOwnedBrowser: false }
  }
  if (worktreeId) {
    const { sourceOwner, destinations } = resolveNativeChatHttpLinkRouting(
      useAppStore.getState(),
      worktreeId
    )
    const canOpenInOrca = destinations.primary === 'orca' || destinations.alternate === 'orca'
    return sourceOwner.kind === 'unknown'
      ? null
      : { url, worktreeId, sourceOwner, canOpenOwnedBrowser: canOpenInOrca }
  }
  return { url, worktreeId: null, sourceOwner: null, canOpenOwnedBrowser: false }
}

/** Opens the shared link menu for right-clicked http(s) anchors and marked PR/issue controls. */
function useGlobalExternalLinkContextMenu(): {
  menu: GlobalExternalLinkMenu | null
  openedAtRef: React.RefObject<number>
  close: () => void
} {
  const [menu, setMenu] = useState<GlobalExternalLinkMenu | null>(null)
  const openedAtRef = useRef(0)
  const close = useCallback(() => setMenu(null), [])

  useEffect(() => {
    const open = (event: MouseEvent, link: Element, url: string): void => {
      event.preventDefault()
      const target = linkMenuTarget(link, url)
      if (!target) {
        return
      }
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
      openedAtRef.current = Date.now()
      setMenu({ target, point: { x: event.clientX, y: event.clientY } })
    }
    const linkTargetElement = (event: MouseEvent): Element | null => {
      if (event.defaultPrevented) {
        return null
      }
      const element = eventElement(event.target)
      return element && !isInsideEditable(element) ? element : null
    }
    // Capture so a marked control beats its row or card menu, e.g. the worktree card.
    const onMarkedControlContextMenu = (event: MouseEvent): void => {
      const marked = linkTargetElement(event)?.closest(`[${EXTERNAL_URL_ATTRIBUTE}]`)
      const url = parseHttpUrl(marked?.getAttribute(EXTERNAL_URL_ATTRIBUTE))
      if (marked && url) {
        event.stopPropagation()
        open(event, marked, url)
      }
    }
    // Bubble so surfaces with their own link menu (terminal, chat) handle anchors first.
    const onAnchorContextMenu = (event: MouseEvent): void => {
      const anchor = linkTargetElement(event)?.closest('a[href]')
      const url = parseHttpUrl(anchor?.getAttribute('href'))
      if (anchor && url) {
        open(event, anchor, url)
      }
    }
    window.addEventListener('contextmenu', onMarkedControlContextMenu, true)
    window.addEventListener('contextmenu', onAnchorContextMenu)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, close)
    return () => {
      window.removeEventListener('contextmenu', onMarkedControlContextMenu, true)
      window.removeEventListener('contextmenu', onAnchorContextMenu)
      window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, close)
    }
  }, [close])

  return { menu, openedAtRef, close }
}

/** Mounted once at the app root. */
export function GlobalExternalLinkContextMenu(): React.JSX.Element | null {
  const { menu, openedAtRef, close } = useGlobalExternalLinkContextMenu()
  if (!menu) {
    return null
  }
  return (
    <ExternalLinkContextMenu
      // Remount per right-click so the menu anchors at the new pointer.
      key={`${menu.point.x}:${menu.point.y}:${menu.target.url}`}
      menu={menu}
      onOpenChange={(open) => {
        // The opening right-click can land as an outside press on some platforms.
        if (!open && Date.now() - openedAtRef.current >= 100) {
          close()
        }
      }}
    />
  )
}

function ExternalLinkContextMenu({
  menu,
  onOpenChange
}: {
  menu: GlobalExternalLinkMenu
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <DropdownMenu open onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-px opacity-0"
          style={{ left: menu.point.x, top: menu.point.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-52"
        sideOffset={0}
        align="start"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ExternalLinkMenuItems target={menu.target} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
