import { windowDipToCssPx } from '@/lib/ui-zoom'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject
} from 'react'
import { createPortal } from 'react-dom'
import type { BrowserPageContextMenuState } from '../describe-page/browser-page-types'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { BrowserPageContextMenuItems } from './browser-page-context-menu-items'

export function BrowserPageContextMenu({
  browserPageId,
  worktreeId,
  canGoBack,
  canGoForward,
  webviewRef,
  onReload
}: {
  browserPageId: string
  worktreeId: string
  canGoBack: boolean
  canGoForward: boolean
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  onReload: () => void
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
        image: event.image
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

  // Why: the guest owns focus while the menu is open, so hand it back on close —
  // otherwise dismissing leaves the page unable to receive keystrokes.
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
    return [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
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
        className="fixed z-50 max-h-screen min-w-[13rem] scrollbar-sleek overflow-y-auto rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-1 text-black shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:text-white dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]"
      >
        <BrowserPageContextMenuItems
          menu={contextMenu}
          browserPageId={browserPageId}
          worktreeId={worktreeId}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          webviewRef={webviewRef}
          onReload={onReload}
          onClose={closeMenu}
        />
      </div>
    </>,
    document.body
  )
}
