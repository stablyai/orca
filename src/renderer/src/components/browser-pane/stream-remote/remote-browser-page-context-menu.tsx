import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { redactKagiSessionToken } from '../../../../../shared/browser/navigation/browser-url'
import type { BrowserPageContextMenuState } from '../describe-page/browser-page-types'
import {
  BrowserPageContextMenuItems,
  type BrowserPageContextMenuActions
} from '../assemble-chrome/context-menu/browser-page-context-menu-items'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type { RemoteBrowserHostContextMenus } from './remote-browser-host-context-menus'
import { openRemoteBrowserLinkInNewTab } from './remote-browser-page-open-link-tab'
import {
  remoteBrowserPageMenuActions,
  type RemoteBrowserPageMenuActionDeps
} from './remote-browser-page-menu-actions'
import {
  buildRemoteContextMenuExpression,
  readRemoteContextMenuResult,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

/** `fromHost`: the host page's own menu report, so the host's spelling and image items apply. */
export type RemoteBrowserPageContextMenuState = BrowserPageContextMenuState & { fromHost: boolean }

export function useRemoteBrowserPageContextMenu({
  busy,
  pagePointerOwned,
  hostContextMenus,
  browserTabUrl,
  imageRef,
  runtimeTarget,
  lifecycle,
  runtimeWorktree,
  getRemoteImagePoint,
  enqueueRemoteInput,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  closeMissingRemotePage,
  mountedRef,
  setPaneNotice
}: {
  busy: boolean
  /** The forwarded right press is the page tool's; Orca's menu would cover what it picks. */
  pagePointerOwned: boolean
  hostContextMenus: RemoteBrowserHostContextMenus
  browserTabUrl: string
  imageRef: React.RefObject<HTMLImageElement | null>
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => { x: number; y: number } | null
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  mountedRef: React.RefObject<boolean>
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
}): {
  contextMenu: RemoteBrowserPageContextMenuState | null
  setContextMenu: React.Dispatch<React.SetStateAction<RemoteBrowserPageContextMenuState | null>>
  handleRemoteContextMenu: (event: React.MouseEvent<HTMLImageElement>) => void
} {
  const [contextMenu, setContextMenu] = useState<RemoteBrowserPageContextMenuState | null>(null)

  useEffect(() => {
    hostContextMenus.setListener((menu, press) => {
      setPaneNotice(null)
      setContextMenu({
        ...menu,
        x: press.clientX,
        y: press.clientY,
        pagePoint: { x: menu.x, y: menu.y },
        fromHost: true
      })
    })
    return () => hostContextMenus.setListener(null)
  }, [hostContextMenus, setPaneNotice])

  useEffect(() => {
    if (!contextMenu) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setContextMenu(null)
      }
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [contextMenu])

  const handleRemoteContextMenu = (event: React.MouseEvent<HTMLImageElement>): void => {
    if (pagePointerOwned) {
      event.preventDefault()
      return
    }
    // The forwarded press opens the page's own menu, if any, which the host then reports. A menu
    // key sends no press, so it keeps the probed menu.
    if (hostContextMenus.supported && hostContextMenus.hasPendingPress) {
      event.preventDefault()
      return
    }
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const point = getRemoteImagePoint(event)
    if (!target || !pageId || !point) {
      return
    }
    event.preventDefault()
    imageRef.current?.focus()
    setPaneNotice(null)
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      pagePoint: point,
      linkUrl: null,
      pageUrl: browserTabUrl || 'about:blank',
      // Why: filled in below once the async eval reads what is under the pointer.
      selectionText: '',
      editable: null,
      image: null,
      fromHost: false
    })
    enqueueRemoteInput(async () => {
      const operationToken = createRemoteOperationToken(pageId)
      if (!operationToken || !isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        const result = await callRuntimeRpc(
          target,
          'browser.eval',
          {
            worktree: runtimeWorktree,
            page: pageId,
            expression: buildRemoteContextMenuExpression(point.x, point.y)
          },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        const parsed = readRemoteContextMenuResult(result)
        if (parsed && mountedRef.current && isCurrentRemoteOperationToken(operationToken)) {
          setContextMenu((current) =>
            current
              ? { ...current, ...parsed, pageUrl: redactKagiSessionToken(parsed.pageUrl) }
              : current
          )
        }
      } catch (error) {
        if (
          isCurrentRemoteOperationToken(operationToken) &&
          isRemoteBrowserPageMissingError(error)
        ) {
          closeMissingRemotePage(pageId)
        }
        // Keep the basic menu open even if element inspection is unavailable.
      }
    })
  }

  return { contextMenu, setContextMenu, handleRemoteContextMenu }
}

export function RemoteBrowserPageContextMenu({
  contextMenu,
  onDismiss,
  history,
  actions,
  linkTab,
  pageMenuDeps
}: {
  contextMenu: RemoteBrowserPageContextMenuState
  onDismiss: () => void
  history: { canGoBack: boolean; canGoForward: boolean }
  actions: Omit<BrowserPageContextMenuActions, 'openInNewTab'>
  /** The pane's tab, beside which Open Link and Open Image open theirs. */
  linkTab: { browserPageId: string; worktreeId: string; runtimeEnvironmentId: string }
  pageMenuDeps: RemoteBrowserPageMenuActionDeps
}): React.JSX.Element {
  const contextMenuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = contextMenuRef.current
    if (!el) {
      return
    }
    el.style.left = `${contextMenu.x}px`
    el.style.top = `${contextMenu.y}px`
    const rect = el.getBoundingClientRect()
    const offsetX = contextMenu.x - rect.left
    const offsetY = contextMenu.y - rect.top
    let renderX = contextMenu.x
    let renderY = contextMenu.y
    if (rect.right > window.innerWidth) {
      renderX = contextMenu.x - rect.width
    }
    if (rect.bottom > window.innerHeight) {
      renderY = contextMenu.y - rect.height
    }
    el.style.left = `${Math.max(0, renderX) + offsetX}px`
    el.style.top = `${Math.max(0, renderY) + offsetY}px`
  }, [contextMenu])

  return createPortal(
    <>
      <div className="fixed inset-0 z-50" onPointerDown={onDismiss} />
      <div
        ref={contextMenuRef}
        role="menu"
        data-testid="remote-browser-context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        className="fixed z-50 min-w-[13rem] overflow-hidden rounded-[11px] border border-black/14 bg-floating-surface p-1 text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]"
      >
        <BrowserPageContextMenuItems
          menu={contextMenu}
          canGoBack={history.canGoBack}
          canGoForward={history.canGoForward}
          actions={{
            ...actions,
            openInNewTab: (url, activate) =>
              openRemoteBrowserLinkInNewTab({
                ...linkTab,
                url,
                activate,
                setPaneNotice: pageMenuDeps.setPaneNotice
              }),
            ...remoteBrowserPageMenuActions(pageMenuDeps, contextMenu)
          }}
          onClose={onDismiss}
        />
      </div>
    </>,
    document.body
  )
}
