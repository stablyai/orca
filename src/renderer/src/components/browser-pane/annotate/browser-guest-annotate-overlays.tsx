import type { BrowserGrabPayload } from '../../../../../shared/browser/element-grab/browser-grab-types'
import { useHeldGrabAction } from './palette/use-held-grab-action'
import { useCallback, useEffect, useState } from 'react'
import {
  interceptAnnotateEscape,
  registerAnnotateEscapeInterceptor
} from './palette/annotate-escape-interceptor'
import { useAnnotateKeyPage } from './palette/use-annotate-key-page'
import { useHeldGrabPick } from './palette/use-held-grab-pick'
import { useNotesTrayPlacement } from './palette/use-notes-tray-placement'
import { returnFocusAfterNotesClose } from './palette/palette-focus-and-fit'
import { createPortal } from 'react-dom'
import type { RefObject } from 'react'
import { GrabConfirmationMenu } from './grab/grab-confirmation-menu'
import { useTranslate } from '@/i18n/use-translate'
import { MarkupOverlay } from './MarkupOverlay'
import type { MarkupModeController } from './capture/useMarkupMode'
import type { GrabModeHook } from './grab/useGrabMode'
import {
  getBrowserOverlayAnchor,
  type OverlayRectSource,
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
import type { MarkupPaletteDensity } from './palette/MarkupPaletteTools'
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
  guestSurfaceRef,
  browserOverlayViewport,
  worktreeId,
  currentUrl,
  toolSwitch,
  canPickElements = false,
  showPaletteKeyHints = false,
  toolsUnavailableReason
}: {
  markup?: MarkupModeController
  grab: GrabModeHook
  annotationSend: ReturnType<typeof useBrowserPageAnnotationSend>
  grabAnnotations: ReturnType<typeof useBrowserPageGrabAnnotations>
  containerRef: RefObject<HTMLDivElement | null>
  markupPortalContainer?: HTMLDivElement | null
  markupControlsContainer?: HTMLDivElement | null
  guestSurfaceRef: RefObject<OverlayRectSource | null>
  browserOverlayViewport: BrowserOverlayViewport
  worktreeId: string
  currentUrl?: string
  toolSwitch?: BrowserAnnotateToolSwitch
  /** False on blank tabs, where the picker and Draw have nothing to work on. */
  canPickElements?: boolean
  /** Only where the A/G/D keys are wired. */
  showPaletteKeyHints?: boolean
  /** Why the tools can't be used (a failed load); the palette's disabled tools say it. */
  toolsUnavailableReason?: string
}): React.JSX.Element {
  const t = useTranslate()
  const [drawSlot, setDrawSlot] = useState<HTMLElement | null>(null)
  const [drawDensity, setDrawDensity] = useState<MarkupPaletteDensity>('full')
  const [notesRevealSignal, setNotesRevealSignal] = useState(0)
  const [notesOpen, setNotesOpen] = useState(false)
  const notesPlacement = useNotesTrayPlacement(containerRef, notesOpen)
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

  const activeTool = toolSwitch?.activeTool ?? null
  const drafts = useBrowserAnnotationDrafts(activeTool !== null)
  if (activeTool !== 'annotate' && notesOpen) {
    setNotesOpen(false)
  }
  // Esc closes an open list first (from the palette, the list or the page) and hands focus back to the chip;
  // the next Esc leaves the mode. The picker asks this interceptor before exiting.
  const notesPageId = toolSwitch?.toolTargetId ?? grab.browserPageId ?? ''
  useAnnotateKeyPage({
    pageId: notesPageId,
    containerRef,
    markupPortalContainer,
    paletteToolActive: activeTool !== null,
    grabActive: grab.state !== 'idle',
    markupActive: markup?.isActive === true
  })
  useEffect(() => {
    if (!notesOpen) {
      return
    }
    return registerAnnotateEscapeInterceptor(notesPageId, () => {
      setNotesOpen(false)
      returnFocusAfterNotesClose(containerRef.current)
      return true
    })
  }, [containerRef, notesOpen, notesPageId])
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
  const { payload: paletteHeldPayload, retire: retireHeldPick } = useHeldGrabPick({
    grab,
    grabIntent,
    activeTool,
    owner: toolSwitch?.drawOwner ?? notesPageId,
    pageId: notesPageId,
    currentUrl
  })
  const heldPayload = toolSwitch
    ? paletteHeldPayload
    : grab.state === 'confirming' && grabIntent === 'copy'
      ? grab.payload
      : null
  const retirePick = useCallback(
    (payload: BrowserGrabPayload) => {
      retireHeldPick(payload)
      if (!toolSwitch && grab.payload === payload) {
        grab.cancel()
      }
    },
    [grab, retireHeldPick, toolSwitch]
  )
  const runPaletteGrabAction = useHeldGrabAction(
    heldPayload,
    notesPageId,
    retirePick,
    grab.transport
  )
  // Leaving the mode with the Send menu open must not leave its agent-target mode behind.
  const { annotationBannerSendOpen, handleAnnotationBannerSendOpenChange } = annotationSend
  useEffect(() => {
    if (toolSwitch && activeTool === null && annotationBannerSendOpen) {
      handleAnnotationBannerSendOpenChange(false)
    }
  }, [activeTool, annotationBannerSendOpen, handleAnnotationBannerSendOpenChange, toolSwitch])
  const paletteHint = activeTool
    ? browserAnnotatePaletteHint({
        t,
        activeTool,
        grab,
        grabIntent,
        hasPendingAnnotation: pendingAnnotationPayload !== null,
        browserAnnotationsLength: browserAnnotations.length,
        drawWaitingForPage: toolSwitch?.drawWaitingForPage ?? false
      })
    : null

  return (
    <>
      {activeTool && paletteHint && toolSwitch ? (
        <BrowserAnnotateToolPalette
          boundsRef={containerRef}
          // Only browser pages mirror Alt from a focused page; the preview's guest forwards no keys.
          pageId={showPaletteKeyHints ? toolSwitch.toolTargetId : null}
          ownerPageId={toolSwitch.toolTargetId}
          labelAvoidFrameRef={guestSurfaceRef}
          activeTool={activeTool}
          onSelectTool={toolSwitch.selectTool}
          onDone={toolSwitch.exit}
          canPickElements={canPickElements}
          unavailableReason={toolsUnavailableReason}
          showKeyHints={showPaletteKeyHints}
          drawWaitingForPage={toolSwitch?.drawWaitingForPage ?? false}
          drawHasActions={markup?.baseImage !== null}
          hint={paletteHint.text}
          hintIsError={paletteHint.isError}
          hintKeepsWhenCompact={paletteHint.keepWhenCompact === true}
          annotateActions={
            browserAnnotations.length > 0
              ? (short) => (
                  <BrowserAnnotatePaletteNotes
                    count={browserAnnotations.length}
                    short={short}
                    notesOpen={notesOpen}
                    onShowNotes={() => {
                      if (notesOpen) {
                        setNotesOpen(false)
                        return
                      }
                      setNotesOpen(true)
                      setNotesRevealSignal((signal) => signal + 1)
                    }}
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
          // Copied belongs to the pick it copied; a new pick within the toast's 2 s starts fresh.
          grabCopyDone={grabToast?.copied === true && grabToast.payload === heldPayload}
          grabPicked={heldPayload !== null}
          grabCanScreenshot={Boolean(
            heldPayload?.screenshot?.dataUrl?.startsWith('data:image/png;')
          )}
          onGrabCopy={() => {
            if (heldPayload) {
              runPaletteGrabAction(() => {
                handleGrabCopy(heldPayload)
                grabMenuActionTakenRef.current = false
              })
            }
          }}
          onGrabScreenshot={() => {
            if (heldPayload) {
              runPaletteGrabAction(() => {
                handleGrabCopyScreenshot(heldPayload)
                grabMenuActionTakenRef.current = false
              })
            }
          }}
          onDrawSlotChange={setDrawSlot}
          onDrawDensityChange={setDrawDensity}
        />
      ) : null}
      {markup?.isActive && markup.baseImage && markupTarget && toolSwitch
        ? createPortal(
            <MarkupOverlay
              key={toolSwitch.drawSession}
              baseImage={markup?.baseImage}
              busy={markup.state === 'composing'}
              onComplete={(input) => void markup.complete(input)}
              // Esc and Cancel go through the switch, so a discarded drawing can be undone.
              onCancel={toolSwitch.exit}
              controlsContainer={markupControlsContainer}
              paletteSlot={drawSlot}
              ownerPageId={toolSwitch.toolTargetId}
              paletteDensity={drawDensity}
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
          // An open notes list closes before the card (A8 order).
          onEscape={() => interceptAnnotateEscape(notesPageId)}
          payload={pendingAnnotationPayload}
          worktreeId={worktreeId}
          resolveAnchor={(cardHeight) =>
            getBrowserOverlayAnchor(
              pendingAnnotationPayload,
              containerRef.current,
              guestSurfaceRef.current,
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
      {browserAnnotations.length > 0 && (activeTool === null || notesOpen) ? (
        <BrowserPageAnnotationTray
          revealSignal={notesRevealSignal}
          placement={notesPlacement}
          onDismiss={
            activeTool === null
              ? undefined
              : () => {
                  setNotesOpen(false)
                  containerRef.current
                    ?.querySelector<HTMLElement>('[data-browser-annotate-notes-chip]')
                    ?.focus({ preventScroll: true })
                }
          }
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
      <GrabConfirmationMenu
        grab={grab}
        payload={heldPayload}
        menuActionTakenRef={grabMenuActionTakenRef}
        containerRef={containerRef}
        guestSurfaceRef={guestSurfaceRef}
        onCopy={() => {
          if (heldPayload) {
            runPaletteGrabAction(() => handleGrabCopy(heldPayload))
          }
        }}
        onScreenshot={() => {
          if (heldPayload) {
            runPaletteGrabAction(() => handleGrabCopyScreenshot(heldPayload))
          }
        }}
      />

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
