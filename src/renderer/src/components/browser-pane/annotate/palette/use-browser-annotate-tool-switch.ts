import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useGrabCleanCapture } from './use-grab-clean-capture'
import { translate } from '@/i18n/i18n'
import { INLINE_ACTION_CLASS_NAMES } from '@/components/ui/sonner'
import type {
  BrowserAnnotateToolKey,
  GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { GrabModeHook } from '../grab/useGrabMode'
import type { MarkupModeController, MarkupResumeSnapshot } from '../capture/useMarkupMode'
import type { MarkupShape } from '../drawing/markup-drawing-model'
import { usePendingDrawEscape } from './use-pending-draw-escape'

const DISCARDED_DRAWING_UNDO_MS = 5000

import {
  TOOL_BY_KEY,
  getBrowserAnnotateActiveTool,
  type BrowserAnnotateTool,
  type BrowserAnnotateToolSwitch
} from './browser-annotate-tool-types'

export {
  getBrowserAnnotateActiveTool,
  type BrowserAnnotateTool,
  type BrowserAnnotateToolSwitch
} from './browser-annotate-tool-types'

/**
 * The one owner of Annotate / Grab / Draw transitions for a page. Every entry (palette, toolbar, chords, page keys)
 * goes through it, so the picker and Draw never run together and Draw never captures over the picker's overlay.
 */
export function useBrowserAnnotateToolSwitch({
  grab,
  grabIntent,
  startGrabIntent,
  cancelPendingBrowserCapture,
  markup,
  canPickElements,
  toolTargetId,
  documentKey,
  documentReady = true
}: {
  grab: GrabModeHook
  grabIntent: GrabIntent
  /** Owns intent changes, including dropping a held pick when the intent changes. */
  startGrabIntent: (intent: GrabIntent) => void
  /** Stops the picker and drops the unsaved comment card and grab toast in one step. */
  cancelPendingBrowserCapture: () => void
  markup: MarkupModeController
  /** False where there is nothing to pick or draw on (blank tab, preview not ready). */
  canPickElements: boolean
  /** The guest the picker runs in; Draw waits for its overlay teardown before capturing. */
  toolTargetId: string
  /** Changes when the page's document changes (navigation, preview reload); a pending Draw for the old one is dropped. */
  documentKey: string
  /** False while the document is (re)loading; each fall starts a new document generation, even at the same key. */
  documentReady?: boolean
}): BrowserAnnotateToolSwitch {
  // A→B→A and same-URL reloads must not revive a prior document's pending capture or Undo.
  const cancelMarkup = markup.cancel
  const documentBase = `${toolTargetId}\n${documentKey}`
  const usable = documentReady && canPickElements
  const [documentGeneration, setDocumentGeneration] = useState({
    base: documentBase,
    ready: usable,
    generation: 0
  })
  let generation = documentGeneration.generation
  if (documentGeneration.base !== documentBase || documentGeneration.ready !== usable) {
    generation += documentGeneration.base !== documentBase || !usable ? 1 : 0
    setDocumentGeneration({ base: documentBase, ready: usable, generation })
  }
  const drawOwner = `${documentBase}\n${generation}`
  const [drawStartingFor, setDrawStartingFor] = useState<string | null>(null)
  if (drawStartingFor !== null && drawStartingFor !== drawOwner) {
    setDrawStartingFor(null)
  }
  const drawStarting = canPickElements && drawStartingFor === drawOwner
  const [drawSession, setDrawSession] = useState(0)
  const activeTool = getBrowserAnnotateActiveTool(
    grab.state,
    grabIntent,
    markup.isActive,
    drawStarting
  )
  const transitionRef = useRef(0)
  const { waitForCleanPage, captureCleanPage, cancelClean } = useGrabCleanCapture()
  const shapesRef = useRef<readonly MarkupShape[]>([])
  const markupActiveRef = useRef(markup.isActive)
  const liveDocumentRef = useRef({ drawOwner, canPickElements, documentReady })
  const captureWhenReadyRef = useRef<{ owner: string; transition: number } | null>(null)
  const [waitingForPageOwner, setWaitingForPageOwner] = useState<string | null>(null)
  useLayoutEffect(() => {
    markupActiveRef.current = markup.isActive
    liveDocumentRef.current = { drawOwner, canPickElements, documentReady }
  }, [canPickElements, documentReady, drawOwner, markup.isActive])
  const [restoredShapes, setRestoredShapes] = useState<readonly MarkupShape[] | undefined>()
  const undoToastRef = useRef<string | number | null>(null)
  const discardedRef = useRef<{
    saved: MarkupResumeSnapshot
    shapes: readonly MarkupShape[]
    owner: string
  } | null>(null)
  const dismissUndo = useCallback((): void => {
    discardedRef.current = null
    if (undoToastRef.current !== null) {
      toast.dismiss(undoToastRef.current)
      undoToastRef.current = null
    }
  }, [])
  useLayoutEffect(() => {
    return () => {
      transitionRef.current += 1
      cancelClean()
      cancelMarkup()
      // An Undo from another page or document would reopen a stale screenshot.
      dismissUndo()
    }
  }, [cancelClean, cancelMarkup, dismissUndo, drawOwner])

  const reportShapes = useCallback((shapes: readonly MarkupShape[]): void => {
    shapesRef.current = shapes
  }, [])

  const reopenDrawing = useCallback(
    (saved: MarkupResumeSnapshot, shapes: readonly MarkupShape[]): void => {
      // Recovery is single-use: whichever entry restores it (toast Undo or re-entering Draw) consumes it, so a later
      // Draw after Clear or Copy never brings an outdated drawing back.
      discardedRef.current = null
      undoToastRef.current = null
      // A drawing that is open now is never replaced (starting it dismissed this Undo; this is a backstop).
      // Read live: this runs from a toast created several renders ago.
      if (markupActiveRef.current) {
        return
      }
      transitionRef.current += 1
      setDrawSession((session) => session + 1)
      setDrawStartingFor(null)
      cancelPendingBrowserCapture()
      setRestoredShapes(shapes)
      markup.resume(saved)
    },
    [cancelPendingBrowserCapture, markup]
  )

  const leaveDraw = useCallback((): void => {
    const saved = markup.snapshot()
    const shapes = shapesRef.current
    markup.cancel()
    shapesRef.current = []
    if (!saved || shapes.length === 0) {
      return
    }
    const discarded = { saved, shapes, owner: drawOwner }
    discardedRef.current = discarded
    const expire = (): void => {
      if (discardedRef.current === discarded) {
        discardedRef.current = null
      }
    }
    undoToastRef.current = toast(
      translate('browser.annotatePalette.drawingDiscarded', 'Drawing discarded'),
      {
        duration: DISCARDED_DRAWING_UNDO_MS,
        // A short outcome reads best with Undo beside it.
        classNames: INLINE_ACTION_CLASS_NAMES,
        onAutoClose: expire,
        onDismiss: expire,
        action: {
          label: translate('browser.annotatePalette.undo', 'Undo'),
          // Only while this is still the drawing on offer: re-entering Draw, a newer discard, expiry or a new
          // document consumed it, and a toast still fading out must not bring it back.
          onClick: () => {
            if (discardedRef.current === discarded) {
              reopenDrawing(saved, shapes)
            }
          }
        }
      }
    )
  }, [drawOwner, markup, reopenDrawing])

  const startDraw = useCallback(
    (transition: number): void => {
      // Back to Draw while the discarded drawing can still be undone: bring that drawing back, no new capture.
      const discarded = discardedRef.current
      if (discarded && discarded.owner === drawOwner) {
        dismissUndo()
        reopenDrawing(discarded.saved, discarded.shapes)
        return
      }
      const owner = drawOwner
      setWaitingForPageOwner(liveDocumentRef.current.documentReady ? null : owner)
      setDrawStartingFor(owner)
      cancelPendingBrowserCapture()
      void waitForCleanPage(toolTargetId).then((tornDown) => {
        // Anything since (another tool, exit, a new document, the page becoming unusable) supersedes this start.
        if (
          transitionRef.current !== transition ||
          liveDocumentRef.current.drawOwner !== owner ||
          !liveDocumentRef.current.canPickElements
        ) {
          return
        }
        // Still loading: capture the finished page, not a half-painted one. A new load before then is a new
        // document generation, which drops this start.
        if (tornDown && !liveDocumentRef.current.documentReady) {
          setRestoredShapes(undefined)
          setDrawSession((session) => session + 1)
          captureWhenReadyRef.current = { owner, transition }
          setWaitingForPageOwner(owner)
          return
        }
        setDrawStartingFor(null)
        setRestoredShapes(undefined)
        setDrawSession((session) => session + 1)
        if (!tornDown) {
          // No clean page to freeze; leave the mode rather than draw over the picker's overlay.
          toast.error(
            translate(
              'auto.components.browser-pane.markup.errorCapture',
              'Could not capture the page to draw on.'
            )
          )
          return
        }
        void markup.start(() => captureCleanPage(toolTargetId))
      })
    },
    [
      cancelPendingBrowserCapture,
      captureCleanPage,
      dismissUndo,
      drawOwner,
      markup,
      reopenDrawing,
      toolTargetId,
      waitForCleanPage
    ]
  )

  useEffect(() => {
    const waiting = captureWhenReadyRef.current
    if (!waiting || !usable) {
      return
    }
    captureWhenReadyRef.current = null
    if (waiting.owner !== drawOwner || waiting.transition !== transitionRef.current) {
      return
    }
    const settle = (): void => {
      setWaitingForPageOwner(null)
      if (transitionRef.current === waiting.transition) {
        setDrawStartingFor(null)
      }
    }
    void markup.start(() => captureCleanPage(toolTargetId)).then(settle, settle)
  }, [captureCleanPage, drawOwner, markup, toolTargetId, usable])

  const selectTool = useCallback(
    (tool: BrowserAnnotateTool): void => {
      if (tool === activeTool || !canPickElements) {
        return
      }
      cancelClean()
      const transition = (transitionRef.current += 1)
      setDrawStartingFor(null)
      setWaitingForPageOwner(null)
      captureWhenReadyRef.current = null
      if (tool === 'draw') {
        startDraw(transition)
        return
      }
      if (markup.isActive) {
        leaveDraw()
      } else {
        cancelMarkup()
      }
      startGrabIntent(tool)
    },
    [
      activeTool,
      cancelClean,
      cancelMarkup,
      canPickElements,
      leaveDraw,
      markup.isActive,
      startDraw,
      startGrabIntent
    ]
  )

  const exit = useCallback((): void => {
    transitionRef.current += 1
    cancelClean()
    setDrawStartingFor(null)
    setWaitingForPageOwner(null)
    captureWhenReadyRef.current = null
    if (markup.isActive) {
      leaveDraw()
      return
    }
    cancelPendingBrowserCapture()
  }, [cancelClean, cancelPendingBrowserCapture, leaveDraw, markup.isActive])

  const toggleTool = useCallback(
    (tool: BrowserAnnotateTool): void => {
      if (tool === activeTool) {
        exit()
        return
      }
      selectTool(tool)
    },
    [activeTool, exit, selectTool]
  )

  const selectToolByKey = useCallback(
    (key: BrowserAnnotateToolKey): void => selectTool(TOOL_BY_KEY[key]),
    [selectTool]
  )

  usePendingDrawEscape({ waiting: drawStarting, markup, pageId: toolTargetId, exit })

  return {
    activeTool,
    selectTool,
    toggleTool,
    selectToolByKey,
    exit,
    toolTargetId,
    reportShapes,
    restoredShapes,
    drawSession,
    drawOwner,
    drawWaitingForPage: drawStarting && waitingForPageOwner === drawOwner
  }
}
