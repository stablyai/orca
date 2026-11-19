import { useCallback, useEffect, useState } from 'react'
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
import { useTranslate } from '@/i18n/use-translate'
import { MarkupOverlay } from './MarkupOverlay'
import type { MarkupModeController } from './capture/useMarkupMode'
import type { GrabModeHook } from './grab/useGrabMode'
import {
  getBrowserOverlayAnchor,
  type BrowserOverlayViewport
} from '../describe-page/browser-annotation-geometry'
import { BrowserPageAnnotationTray } from './browser-page-annotation-tray'
import { BrowserPageGrabToast } from './grab/browser-page-grab-toast'
import {
  PendingBrowserAnnotationCard,
  type BrowserAnnotationDraft
} from './delivery/pending-browser-annotation-card'
import {
  browserAnnotationDraftKey,
  useBrowserAnnotationDrafts
} from './delivery/use-browser-annotation-drafts'
import type { useBrowserPageAnnotationSend } from './delivery/use-browser-page-annotation-send'
import type { useBrowserPageGrabAnnotations } from './grab/use-browser-page-grab-annotations'
import { BrowserAnnotateToolPalette } from './palette/BrowserAnnotateToolPalette'
import { BrowserAnnotatePaletteNotes } from './palette/browser-annotate-palette-send'
import { BrowserAnnotationSendMenuContent } from './delivery/BrowserAnnotationSendMenuContent'
import { browserAnnotatePaletteHint } from './palette/browser-annotate-palette-hint'
import type { BrowserAnnotateToolSwitch } from './palette/use-browser-annotate-tool-switch'

/** Pair guest tools with all their result overlays so every surface that arms a picker can display its result. */
export function BrowserGuestAnnotateOverlays({
  markup,
  grab,
  annotationSend,
  grabAnnotations,
  containerRef,
  markupPortalContainer,
  markupControlsContainer,
  webviewRef,
  browserOverlayViewport,
  worktreeId,
  currentUrl,
  toolSwitch,
  canPickElements,
  showPaletteKeyHints
}: {
  markup: MarkupModeController
  grab: GrabModeHook
  annotationSend: ReturnType<typeof useBrowserPageAnnotationSend>
  grabAnnotations: ReturnType<typeof useBrowserPageGrabAnnotations>
  containerRef: RefObject<HTMLDivElement | null>
  markupPortalContainer?: HTMLDivElement | null
  markupControlsContainer?: HTMLDivElement | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  browserOverlayViewport: BrowserOverlayViewport
  worktreeId: string
  currentUrl?: string
  toolSwitch: BrowserAnnotateToolSwitch
  /** False on blank tabs, where the picker and Draw have nothing to work on. */
  canPickElements: boolean
  /** Only where the A/G/D keys are wired. */
  showPaletteKeyHints: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [drawSlot, setDrawSlot] = useState<HTMLElement | null>(null)
  const [drawCompact, setDrawCompact] = useState(false)
  const [notesRevealSignal, setNotesRevealSignal] = useState(0)
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
    copyGrabScreenshot,
    setGrabToast
  } = grabAnnotations
  const markupTarget = markupPortalContainer ?? containerRef.current
  const {
    browserAnnotations,
    annotationTraySendOpen,
    handleAnnotationTraySendOpenChange,
    activeGroupId,
    browserAnnotationsPrompt,
    includePageDetails,
    handleIncludePageDetailsChange,
    handleBrowserAnnotationsSentToAgent,
    handleBrowserAnnotationsHandedOff,
    handleCopyBrowserAnnotations,
    browserAnnotationsCopied,
    handleClearBrowserAnnotations,
    handleDeleteBrowserAnnotation,
    handleUpdateBrowserAnnotation
  } = annotationSend

  const activeTool = toolSwitch.activeTool
  const drafts = useBrowserAnnotationDrafts(activeTool !== null)
  const pendingDraftKey = pendingAnnotationPayload
    ? browserAnnotationDraftKey(pendingAnnotationPayload)
    : null
  const { set: setDraft } = drafts
  const onPendingDraftChange = useCallback(
    (draft: BrowserAnnotationDraft): void => {
      if (pendingDraftKey !== null) {
        setDraft(pendingDraftKey, draft)
      }
    },
    [pendingDraftKey, setDraft]
  )
  // Palette buttons act on the picked element only; hovering keeps using C/S, so the target can't shift en route.
  const grabPicked = grab.state === 'confirming' && grab.payload !== null && grabIntent === 'copy'
  const runPaletteGrabAction = (action: () => void): void => {
    action()
    // These handlers flag the right-click menu as handled; nothing from that menu is open here.
    grabMenuActionTakenRef.current = false
  }
  // Leaving the mode with the Send menu open must not leave its agent-target mode behind.
  const { annotationBannerSendOpen, handleAnnotationBannerSendOpenChange } = annotationSend
  useEffect(() => {
    if (activeTool === null && annotationBannerSendOpen) {
      handleAnnotationBannerSendOpenChange(false)
    }
  }, [activeTool, annotationBannerSendOpen, handleAnnotationBannerSendOpenChange])
  const paletteHint = activeTool
    ? browserAnnotatePaletteHint({
        t,
        activeTool,
        grab,
        grabIntent,
        hasPendingAnnotation: pendingAnnotationPayload !== null,
        browserAnnotationsLength: browserAnnotations.length
      })
    : null

  return (
    <>
      {activeTool && paletteHint ? (
        <BrowserAnnotateToolPalette
          boundsRef={containerRef}
          // Only browser pages mirror Alt from a focused page; the preview's guest forwards no keys.
          pageId={showPaletteKeyHints ? toolSwitch.toolTargetId : null}
          activeTool={activeTool}
          onSelectTool={toolSwitch.selectTool}
          onDone={toolSwitch.exit}
          canPickElements={canPickElements}
          showKeyHints={showPaletteKeyHints}
          hint={paletteHint.text}
          hintIsError={paletteHint.isError}
          annotateActions={
            browserAnnotations.length > 0
              ? (short) => (
                  <BrowserAnnotatePaletteNotes
                    count={browserAnnotations.length}
                    short={short}
                    onShowNotes={() => setNotesRevealSignal((signal) => signal + 1)}
                    sendOpen={annotationBannerSendOpen}
                    onSendOpenChange={handleAnnotationBannerSendOpenChange}
                    sendDisabled={!browserAnnotationsPrompt}
                    sendMenu={
                      <BrowserAnnotationSendMenuContent
                        worktreeId={worktreeId}
                        groupId={activeGroupId ?? worktreeId}
                        prompt={browserAnnotationsPrompt}
                        includePageDetails={includePageDetails}
                        onIncludePageDetailsChange={handleIncludePageDetailsChange}
                        onPromptDelivered={handleBrowserAnnotationsSentToAgent}
                        onPromptHandedOff={handleBrowserAnnotationsHandedOff}
                      />
                    }
                  />
                )
              : null
          }
          grabCopyDone={grabToast?.type === 'success'}
          grabPicked={grabPicked}
          grabCanScreenshot={
            grabPicked && Boolean(grab.payload?.screenshot?.dataUrl?.startsWith('data:image/png;'))
          }
          onGrabCopy={() => runPaletteGrabAction(handleGrabCopy)}
          onGrabScreenshot={() => runPaletteGrabAction(handleGrabCopyScreenshot)}
          onDrawSlotChange={setDrawSlot}
          onDrawCompactChange={setDrawCompact}
        />
      ) : null}
      {markup.isActive && markup.baseImage && markupTarget
        ? createPortal(
            <MarkupOverlay
              baseImage={markup.baseImage}
              busy={markup.state === 'composing'}
              onComplete={(input) => void markup.complete(input)}
              // Esc and Cancel go through the switch, so a discarded drawing can be undone.
              onCancel={toolSwitch.exit}
              controlsContainer={markupControlsContainer}
              paletteSlot={drawSlot}
              paletteCompact={drawCompact}
              initialShapes={toolSwitch.restoredShapes}
              onShapesChange={toolSwitch.reportShapes}
            />,
            markupTarget
          )
        : null}
      {pendingAnnotationPayload ? (
        <PendingBrowserAnnotationCard
          key={pendingDraftKey ?? undefined}
          initialDraft={drafts.get(pendingDraftKey)}
          onDraftChange={onPendingDraftChange}
          payload={pendingAnnotationPayload}
          worktreeId={worktreeId}
          resolveAnchor={(cardHeight) =>
            getBrowserOverlayAnchor(
              pendingAnnotationPayload,
              containerRef.current,
              webviewRef.current,
              browserOverlayViewport,
              cardHeight
            )
          }
          portalContainer={containerRef.current}
          onAdd={(comment, intent, imagePaths) => {
            if (pendingDraftKey !== null) {
              drafts.remove(pendingDraftKey)
            }
            handleAddBrowserAnnotation(comment, intent, imagePaths)
          }}
          onCancel={handleCancelPendingBrowserAnnotation}
        />
      ) : null}
      {browserAnnotations.length > 0 ? (
        <BrowserPageAnnotationTray
          revealSignal={notesRevealSignal}
          browserAnnotations={browserAnnotations}
          currentUrl={currentUrl}
          annotationTraySendOpen={annotationTraySendOpen}
          handleAnnotationTraySendOpenChange={handleAnnotationTraySendOpenChange}
          worktreeId={worktreeId}
          activeGroupId={activeGroupId}
          browserAnnotationsPrompt={browserAnnotationsPrompt}
          includePageDetails={includePageDetails}
          handleIncludePageDetailsChange={handleIncludePageDetailsChange}
          handleBrowserAnnotationsSentToAgent={handleBrowserAnnotationsSentToAgent}
          handleBrowserAnnotationsHandedOff={handleBrowserAnnotationsHandedOff}
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
            {t('auto.components.browser.pane.BrowserPane.c2ef0359b9', 'Copy Contents')}
            <DropdownMenuShortcut>C</DropdownMenuShortcut>
          </DropdownMenuItem>
          {grab.payload?.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (
            <DropdownMenuItem onSelect={handleGrabCopyScreenshot}>
              <Image className="size-3.5" />
              {t('auto.components.browser.pane.BrowserPane.1ded0d3168', 'Copy Screenshot')}
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
            {t('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Inline toast bubble; flips above the element when near the viewport bottom so it doesn't occlude it. */}
      {grabToast ? (
        <BrowserPageGrabToast
          grabToast={grabToast}
          grabToastTimerRef={grabToastTimerRef}
          dismissGrabToast={dismissGrabToast}
          copyGrabScreenshot={copyGrabScreenshot}
          setGrabToast={setGrabToast}
        />
      ) : null}
    </>
  )
}
