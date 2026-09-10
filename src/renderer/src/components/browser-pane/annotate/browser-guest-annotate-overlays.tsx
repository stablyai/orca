import { createPortal } from 'react-dom'
import type { MutableRefObject, RefObject } from 'react'
import { Copy, Image } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { MarkupOverlay } from './MarkupOverlay'
import type { MarkupModeController } from './useMarkupMode'
import type { GrabModeHook } from './useGrabMode'
import {
  getBrowserOverlayAnchor,
  type BrowserOverlayViewport
} from '../describe-page/browser-annotation-geometry'
import { BrowserPageAnnotationTray } from './browser-page-annotation-tray'
import { BrowserPageGrabToast } from './browser-page-grab-toast'
import { PendingBrowserAnnotationCard } from './pending-browser-annotation-card'
import type { useBrowserPageAnnotationSend } from './use-browser-page-annotation-send'
import type { useBrowserPageGrabAnnotations } from './use-browser-page-grab-annotations'

/**
 * Everything the annotate and markup tools paint over a guest: the draw surface, the pending
 * comment card, the annotation tray, the right-click grab menu and the inline confirmation toast.
 *
 * Shared because these overlays are the other half of the toolbar's tool cluster — a surface that
 * offers the tools but not these would arm a picker whose result the reader could never see.
 */
export function BrowserGuestAnnotateOverlays({
  markup,
  grab,
  annotationSend,
  grabAnnotations,
  containerRef,
  markupPortalContainer,
  webviewRef,
  browserOverlayViewport,
  worktreeId
}: {
  markup: MarkupModeController
  grab: GrabModeHook
  annotationSend: ReturnType<typeof useBrowserPageAnnotationSend>
  grabAnnotations: ReturnType<typeof useBrowserPageGrabAnnotations>
  containerRef: RefObject<HTMLDivElement | null>
  markupPortalContainer?: HTMLDivElement | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  browserOverlayViewport: BrowserOverlayViewport
  worktreeId: string
}): React.JSX.Element {
  const {
    pendingAnnotationPayload,
    handleAddBrowserAnnotation,
    handleCancelPendingBrowserAnnotation,
    grabIntent,
    grabMenuActionTakenRef,
    handleGrabCopy,
    handleGrabCopyScreenshot,
    grabToast,
    grabToastTimerRef,
    dismissGrabToast,
    setGrabToast
  } = grabAnnotations
  const markupTarget = markupPortalContainer ?? containerRef.current
  const {
    browserAnnotations,
    browserAnnotationTrayOpen,
    annotationTraySendOpen,
    handleAnnotationTraySendOpenChange,
    activeGroupId,
    browserAnnotationsPrompt,
    handleBrowserAnnotationsSentToAgent,
    handleCopyBrowserAnnotations,
    browserAnnotationsCopied,
    handleClearBrowserAnnotations,
    handleDeleteBrowserAnnotation,
    handleUpdateBrowserAnnotation
  } = annotationSend

  return (
    <>
      {markup.isActive && markup.baseImage && markupTarget
        ? createPortal(
            <MarkupOverlay
              baseImage={markup.baseImage}
              busy={markup.state === 'composing'}
              onComplete={(input) => void markup.complete(input)}
              onCancel={markup.cancel}
            />,
            markupTarget
          )
        : null}
      {pendingAnnotationPayload ? (
        <PendingBrowserAnnotationCard
          payload={pendingAnnotationPayload}
          anchor={getBrowserOverlayAnchor(
            pendingAnnotationPayload,
            containerRef.current,
            webviewRef.current,
            browserOverlayViewport
          )}
          portalContainer={containerRef.current}
          onAdd={handleAddBrowserAnnotation}
          onCancel={handleCancelPendingBrowserAnnotation}
        />
      ) : null}
      {browserAnnotations.length > 0 && browserAnnotationTrayOpen ? (
        <BrowserPageAnnotationTray
          browserAnnotations={browserAnnotations}
          annotationTraySendOpen={annotationTraySendOpen}
          handleAnnotationTraySendOpenChange={handleAnnotationTraySendOpenChange}
          worktreeId={worktreeId}
          activeGroupId={activeGroupId}
          browserAnnotationsPrompt={browserAnnotationsPrompt}
          handleBrowserAnnotationsSentToAgent={handleBrowserAnnotationsSentToAgent}
          handleCopyBrowserAnnotations={handleCopyBrowserAnnotations}
          browserAnnotationsCopied={browserAnnotationsCopied}
          handleClearBrowserAnnotations={handleClearBrowserAnnotations}
          handleDeleteBrowserAnnotation={handleDeleteBrowserAnnotation}
          handleUpdateBrowserAnnotation={handleUpdateBrowserAnnotation}
        />
      ) : null}
      {/* Right-click context dropdown, positioned at the grabbed element's center. */}
      <DropdownMenu
        open={grab.state === 'confirming' && grab.contextMenu && grabIntent === 'copy'}
        onOpenChange={(open) => {
          if (!open && grab.state === 'confirming') {
            // Why: skip rearm if a menu action already handled it — see grabMenuActionTakenRef.
            if (grabMenuActionTakenRef.current) {
              grabMenuActionTakenRef.current = false
              return
            }
            grab.rearm()
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={(() => {
              if (!grab.payload) {
                return { left: 0, top: 0 }
              }
              const rect = grab.payload.target.rectViewport
              const webview = webviewRef.current
              const webviewRect = webview?.getBoundingClientRect()
              const cRect = containerRef.current?.getBoundingClientRect()
              const offsetX = (webviewRect?.left ?? 0) - (cRect?.left ?? 0)
              const offsetY = (webviewRect?.top ?? 0) - (cRect?.top ?? 0)
              return {
                left: offsetX + rect.x + rect.width / 2,
                top: offsetY + rect.y + rect.height / 2
              }
            })()}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4}>
          <DropdownMenuItem onSelect={handleGrabCopy}>
            <Copy className="size-3.5" />
            {translate('auto.components.browser.pane.BrowserPane.c2ef0359b9', 'Copy Contents')}
            <DropdownMenuShortcut>C</DropdownMenuShortcut>
          </DropdownMenuItem>
          {grab.payload?.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (
            <DropdownMenuItem onSelect={handleGrabCopyScreenshot}>
              <Image className="size-3.5" />
              {translate('auto.components.browser.pane.BrowserPane.1ded0d3168', 'Copy Screenshot')}
              <DropdownMenuShortcut>S</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              grabMenuActionTakenRef.current = true
              grab.cancel()
            }}
          >
            {translate('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Inline toast bubble; flips above the element when near the viewport bottom so it doesn't occlude it. */}
      {grabToast ? (
        <BrowserPageGrabToast
          grabToast={grabToast}
          grabToastTimerRef={grabToastTimerRef}
          dismissGrabToast={dismissGrabToast}
          setGrabToast={setGrabToast}
        />
      ) : null}
    </>
  )
}
