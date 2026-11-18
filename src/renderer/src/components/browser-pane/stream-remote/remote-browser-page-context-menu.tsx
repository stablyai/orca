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
import {
  buildRemoteContextMenuExpression,
  readRemoteContextMenuResult,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

export function useRemoteBrowserPageContextMenu({
  busy,
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
  contextMenu: BrowserPageContextMenuState | null
  setContextMenu: React.Dispatch<React.SetStateAction<BrowserPageContextMenuState | null>>
  handleRemoteContextMenu: (event: React.MouseEvent<HTMLImageElement>) => void
} {
  const [contextMenu, setContextMenu] = useState<BrowserPageContextMenuState | null>(null)

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
      image: null
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
  actions
}: {
  contextMenu: BrowserPageContextMenuState
  onDismiss: () => void
  history: { canGoBack: boolean; canGoForward: boolean }
  actions: BrowserPageContextMenuActions
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
          actions={actions}
          onClose={onDismiss}
        />
      </div>
    </>,
    document.body
  )
}
