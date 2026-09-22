import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import {
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import {
  buildRemoteContextMenuExpression,
  readRemoteContextMenuResult,
  type RemoteBrowserContextMenu,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

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
  contextMenu: RemoteBrowserContextMenu | null
  setContextMenu: React.Dispatch<React.SetStateAction<RemoteBrowserContextMenu | null>>
  handleRemoteContextMenu: (event: React.MouseEvent<HTMLImageElement>) => void
} {
  const [contextMenu, setContextMenu] = useState<RemoteBrowserContextMenu | null>(null)

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
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
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
      linkUrl: null,
      pageUrl: browserTabUrl || 'about:blank',
      // Why: filled in below once the async eval reads the guest selection.
      selectionText: ''
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
              ? {
                  ...current,
                  linkUrl: parsed.linkUrl,
                  pageUrl: redactKagiSessionToken(parsed.pageUrl),
                  selectionText: parsed.selectionText
                }
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
  onOpenLinkInOrcaBrowser,
  onNavigate
}: {
  contextMenu: RemoteBrowserContextMenu
  onDismiss: () => void
  onOpenLinkInOrcaBrowser: () => void
  onNavigate: (method: 'browser.back' | 'browser.forward' | 'browser.reload') => void
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
        className="fixed z-50 min-w-[13rem] overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-1 text-black shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:text-white dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]"
      >
        {contextMenu.linkUrl ? (
          <>
            <button
              role="menuitem"
              className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
              onClick={onOpenLinkInOrcaBrowser}
            >
              {translate(
                'auto.components.browser.pane.BrowserPane.b5b87d6cbb',
                'Open Link In Orca Browser'
              )}
            </button>
            <button
              role="menuitem"
              className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
              onClick={() => {
                const targetUrl = normalizeExternalBrowserUrl(contextMenu.linkUrl!)
                if (targetUrl) {
                  void window.api.shell.openUrl(targetUrl)
                }
                onDismiss()
              }}
            >
              {translate(
                'auto.components.browser.pane.BrowserPane.8ce4f6b12e',
                'Open Link In Default Browser'
              )}
            </button>
            <button
              role="menuitem"
              className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
              onClick={() => {
                void window.api.ui.writeClipboardText(contextMenu.linkUrl ?? '')
                onDismiss()
              }}
            >
              {translate(
                'auto.components.browser.pane.BrowserPane.efb0e8f7f3',
                'Copy Link Address'
              )}
            </button>
            <div className="my-1 h-px bg-border/70" />
          </>
        ) : null}
        {contextMenu.selectionText.trim() ? (
          <>
            <button
              role="menuitem"
              className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
              onClick={() => {
                void window.api.ui.writeClipboardText(contextMenu.selectionText)
                onDismiss()
              }}
            >
              {translate('auto.components.browser.pane.BrowserPane.2a4c4b8e1f', 'Copy')}
            </button>
            <div className="my-1 h-px bg-border/70" />
          </>
        ) : null}
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => onNavigate('browser.back')}
        >
          {translate('auto.components.browser.pane.BrowserPane.40edfa75cb', 'Back')}
        </button>
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => onNavigate('browser.forward')}
        >
          {translate('auto.components.browser.pane.BrowserPane.250a9b3e42', 'Forward')}
        </button>
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => onNavigate('browser.reload')}
        >
          {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
        </button>
        <div className="my-1 h-px bg-border/70" />
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => {
            const targetUrl = normalizeExternalBrowserUrl(contextMenu.pageUrl)
            if (targetUrl) {
              void window.api.shell.openUrl(targetUrl)
            }
            onDismiss()
          }}
        >
          {translate(
            'auto.components.browser.pane.BrowserPane.f7ab83f7ed',
            'Open Page In Default Browser'
          )}
        </button>
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => {
            void window.api.ui.writeClipboardText(contextMenu.pageUrl)
            onDismiss()
          }}
        >
          {translate('auto.components.browser.pane.BrowserPane.1b179ab561', 'Copy Page URL')}
        </button>
      </div>
    </>,
    document.body
  )
}
