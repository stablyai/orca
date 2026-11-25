import { windowDipToCssPx } from '@/app-shell/chrome/ui-zoom'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject
} from 'react'
import { createPortal } from 'react-dom'
import type { BrowserPageContextMenuState } from '../../describe-page/browser-page-types'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { issueBrowserGuestNavigation } from '../../host-guest/metadata/browser-guest-metadata-cache'
import { openLinkInNewBrowserTab } from '@/lib/browser/palette/open-client-hosted-link-beside-page'
import { normalizeExternalBrowserUrl } from '../../../../../../shared/browser/navigation/browser-url'
import { getRemoteRoutedOpenableExternalUrl } from '../../describe-page/browser-page-url-display'
import {
  BrowserPageContextMenuItems,
  type BrowserPageContextMenuActions
} from './browser-page-context-menu-items'

export function BrowserPageContextMenu({
  browserPageId,
  worktreeId,
  canGoBack,
  canGoForward,
  webviewRef,
  onReload,
  remoteRoutedNetwork = false,
  externalUrl,
  openExternal
}: {
  browserPageId: string
  worktreeId: string
  canGoBack: boolean
  canGoForward: boolean
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  onReload: () => void
  /** The page browses through a remote host, whose loopback this desktop's browser cannot reach. */
  remoteRoutedNetwork?: boolean
  /** Overrides what the system browser opens, e.g. an SSH host's localhost through its port forward. */
  externalUrl?: (url: string) => string | null
  /** Opens what externalUrl returned, e.g. through the forward it names. */
  openExternal?: (url: string) => void
}): React.JSX.Element | null {
  const [contextMenu, setContextMenu] = useState<BrowserPageContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return window.api.browser.onContextMenuRequested((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      // Why: convert OS screen cursor coords to renderer CSS pixels — immune to guest/renderer coordinate-space mismatches from zoom/DPI.
      const x = Math.round(windowDipToCssPx(event.screenX - window.screenX))
      const y = Math.round(windowDipToCssPx(event.screenY - window.screenY))
      setContextMenu({
        x,
        y,
        pagePoint: { x: event.x, y: event.y },
        linkUrl: event.linkUrl,
        pageUrl: event.pageUrl,
        selectionText: event.selectionText ?? '',
        editable: event.editable,
        image: event.image,
        extensionMenu: event.extensionMenu
      })
    })
  }, [browserPageId])

  useEffect(() => {
    return window.api.browser.onContextMenuDismissed((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      setContextMenu(null)
    })
  }, [browserPageId])

  // Return focus to the guest on dismissal so the page can receive keystrokes.
  const closeMenu = useCallback((): void => {
    setContextMenu(null)
    try {
      webviewRef.current?.focus()
    } catch {
      // The guest can be destroyed while its renderer-owned menu is open.
    }
  }, [webviewRef])

  const menuItems = useCallback((): HTMLButtonElement[] => {
    const el = contextMenuRef.current
    if (!el) {
      return []
    }
    // Why :scope chain: items inside an extension's submenu navigate within that submenu.
    return [
      ...el.querySelectorAll<HTMLButtonElement>(
        ':scope > [role^="menuitem"]:not(:disabled), :scope > div:not([role]) > [role^="menuitem"]:not(:disabled)'
      )
    ]
  }, [])

  useEffect(() => {
    if (!contextMenu) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu()
      }
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [closeMenu, contextMenu])

  // Why: role="menu" is unreachable by keyboard unless focus moves in on open.
  useEffect(() => {
    if (!contextMenu) {
      return
    }
    menuItems()[0]?.focus()
  }, [contextMenu, menuItems])

  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const items = menuItems()
      if (items.length === 0) {
        return
      }
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
      let nextIndex: number
      if (e.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % items.length
      } else if (e.key === 'ArrowUp') {
        nextIndex = (currentIndex <= 0 ? items.length : currentIndex) - 1
      } else if (e.key === 'Home') {
        nextIndex = 0
      } else if (e.key === 'End') {
        nextIndex = items.length - 1
      } else {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      items[nextIndex]?.focus()
    },
    [menuItems]
  )

  // Why: ancestor CSS (transform/backdrop-filter) can shift position:fixed even via a body Portal, so measure/correct before paint; also flip on viewport overflow.
  useLayoutEffect(() => {
    const el = contextMenuRef.current
    if (!el || !contextMenu) {
      return
    }
    el.style.left = `${contextMenu.x}px`
    el.style.top = `${contextMenu.y}px`
    const rect = el.getBoundingClientRect()

    // Why: CSS containing blocks can shift "fixed" elements; capture the offset between requested and actual position.
    const offsetX = contextMenu.x - rect.left
    const offsetY = contextMenu.y - rect.top

    let renderX = contextMenu.x
    let renderY = contextMenu.y

    // Flip so the opposite corner aligns with the cursor when the menu overflows.
    if (rect.right > window.innerWidth) {
      renderX = contextMenu.x - rect.width
    }
    if (rect.bottom > window.innerHeight) {
      renderY = contextMenu.y - rect.height
    }

    renderX = Math.max(0, renderX)
    renderY = Math.max(0, renderY)

    el.style.left = `${renderX + offsetX}px`
    el.style.top = `${renderY + offsetY}px`
  }, [contextMenu])

  if (!contextMenu) {
    return null
  }

  const webviewMenuActions = (pagePoint: {
    x: number
    y: number
  }): BrowserPageContextMenuActions => ({
    edit: (command) => webviewRef.current?.[command](),
    replaceMisspelling: (word) => webviewRef.current?.replaceMisspelling(word),
    addWordToDictionary: (word) =>
      void window.api.browser.addWordToDictionary({ browserPageId, word }),
    openInNewTab: (url, activate) =>
      openLinkInNewBrowserTab({ sourcePageId: browserPageId, worktreeId, url, activate }),
    externalUrl:
      externalUrl ??
      (remoteRoutedNetwork ? getRemoteRoutedOpenableExternalUrl : normalizeExternalBrowserUrl),
    openExternal,
    // Use guest download rules for local Downloads or the client-hosted remote workspace.
    saveImage: (url) => webviewRef.current?.downloadURL(url),
    copyImage: () => void window.api.browser.copyImageAt({ browserPageId, point: pagePoint }),
    inspect: () => void window.api.browser.openDevTools({ browserPageId, inspectAt: pagePoint }),
    goBack: () => issueBrowserGuestNavigation(webviewRef.current, (webview) => webview.goBack()),
    goForward: () =>
      issueBrowserGuestNavigation(webviewRef.current, (webview) => webview.goForward()),
    reload: onReload
  })

  return createPortal(
    <>
      <div className="fixed inset-0 z-50" onPointerDown={closeMenu} />
      <div
        ref={contextMenuRef}
        role="menu"
        aria-orientation="vertical"
        tabIndex={-1}
        onKeyDown={handleMenuKeyDown}
        data-testid="browser-context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        className="fixed z-50 max-h-screen min-w-[13rem] scrollbar-sleek overflow-y-auto rounded-[11px] border border-black/14 bg-floating-surface p-1 text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]"
      >
        <BrowserPageContextMenuItems
          menu={contextMenu}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          actions={webviewMenuActions(contextMenu.pagePoint)}
          onClose={closeMenu}
        />
      </div>
    </>,
    document.body
  )
}
