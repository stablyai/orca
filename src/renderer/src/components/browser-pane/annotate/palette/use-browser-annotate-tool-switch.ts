import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { INLINE_ACTION_CLASS_NAMES } from '@/components/ui/sonner'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import type {
  BrowserAnnotateToolKey,
  GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { GrabModeHook } from '../grab/useGrabMode'
import type { MarkupModeController, MarkupResumeSnapshot } from '../capture/useMarkupMode'
import type { MarkupShape } from '../drawing/markup-drawing-model'
import { isEditableKeyboardTarget } from '../../host-guest/input/browser-keyboard'
import { annotateEscOwner } from './annotate-esc-ownership'

const DISCARDED_DRAWING_UNDO_MS = 5000

/** The palette's three tools: the picker's two intents plus screenshot markup. */
export type BrowserAnnotateTool = GrabIntent | 'draw'

export type BrowserAnnotateToolSwitch = {
  /** Null while no tool is on, which hides the palette. */
  activeTool: BrowserAnnotateTool | null
  /** Switch to a tool; the tool that is already on stays on (only exit or toggle turns the mode off). */
  selectTool: (tool: BrowserAnnotateTool) => void
  /** Toolbar, chords and page keys: the tool that is on turns the mode off, any other switches to it. */
  toggleTool: (tool: BrowserAnnotateTool) => void
  selectToolByKey: (key: BrowserAnnotateToolKey) => void
  /** Leave the mode; saved notes stay in the notes list, an unsaved comment card is dropped. */
  exit: () => void
  /** The page the picker runs in. */
  toolTargetId: string
  /** Draw reports its strokes here, so leaving Draw with a drawing can offer Undo. */
  reportShapes: (shapes: readonly MarkupShape[]) => void
  /** Strokes to reopen Draw with after Undo; undefined for a fresh drawing. */
  restoredShapes: readonly MarkupShape[] | undefined
  /** Key for Draw's editor: a new one per drawing session. */
  drawSession: number
  /** The page and document the tools act on; held state for another document is stale. */
  drawOwner: string
}

const TOOL_BY_KEY: Record<BrowserAnnotateToolKey, BrowserAnnotateTool> = {
  a: 'annotate',
  g: 'copy',
  d: 'draw'
}

export function getBrowserAnnotateActiveTool(
  grabState: GrabModeHook['state'],
  grabIntent: GrabIntent,
  markupIsActive: boolean,
  drawStarting = false
): BrowserAnnotateTool | null {
  if (markupIsActive || drawStarting) {
    return 'draw'
  }
  return grabState === 'idle' ? null : grabIntent
}

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
  // Why a generation and not just the key: A → B → A, or a reload of the same URL, brings the key back while the
  // document under it is new. Every key change or loss of readiness starts a new generation, so state held for an
  // older document (pending Draw, held pick, Undo) never matches again.
  const documentBase = `${toolTargetId}\n${documentKey}`
  const usable = documentReady && canPickElements
  const [documentGeneration, setDocumentGeneration] = useState({
    base: documentBase,
    ready: usable,
    generation: 0
  })
  let generation = documentGeneration.generation
  if (documentGeneration.base !== documentBase || documentGeneration.ready !== usable) {
    const newDocument = documentGeneration.base !== documentBase || !usable
    generation += newDocument ? 1 : 0
    setDocumentGeneration({ base: documentBase, ready: usable, generation })
  }
  // Why: between stopping the picker and Draw's capture starting, neither is on; keep the palette on Draw meanwhile.
  const drawOwner = `${documentBase}\n${generation}`
  const [drawStartingFor, setDrawStartingFor] = useState<string | null>(null)
  // A pending Draw for an older document is dropped outright, so it can't come back if the owner string recurs.
  if (drawStartingFor !== null && drawStartingFor !== drawOwner) {
    setDrawStartingFor(null)
  }
  const drawStarting = canPickElements && drawStartingFor === drawOwner
  // A new editor per drawing session, so a reopened drawing never inherits another session's strokes.
  const [drawSession, setDrawSession] = useState(0)
  const activeTool = getBrowserAnnotateActiveTool(
    grab.state,
    grabIntent,
    markup.isActive,
    drawStarting
  )
  // Fences a Draw start still waiting for teardown: any later transition, a page change or unmount supersedes it.
  const transitionRef = useRef(0)
  const shapesRef = useRef<readonly MarkupShape[]>([])
  const markupActiveRef = useRef(markup.isActive)
  // Live owner and capability, read when the overlay teardown resolves, a few frames after Draw was asked for.
  const liveOwnerRef = useRef(drawOwner)
  const canPickRef = useRef(canPickElements)
  useLayoutEffect(() => {
    markupActiveRef.current = markup.isActive
    liveOwnerRef.current = drawOwner
    canPickRef.current = canPickElements
  }, [canPickElements, drawOwner, markup.isActive])
  const [restoredShapes, setRestoredShapes] = useState<readonly MarkupShape[] | undefined>()
  const undoToastRef = useRef<string | number | null>(null)
  // The discarded drawing while its Undo is on offer: entering Draw again in that window restores it.
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
  useEffect(() => {
    return () => {
      transitionRef.current += 1
      // An Undo from another page or document would reopen a stale screenshot.
      dismissUndo()
    }
  }, [dismissUndo, drawOwner])

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

  // Leaving Draw drops the drawing; if it had strokes, offer them back for a few seconds.
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
      setDrawStartingFor(owner)
      cancelPendingBrowserCapture()
      // Why a second, awaited disable: with the pick already cancelled it awaits the overlay teardown script, which
      // the page runs after the cancelled pick's own teardown, so the frozen screenshot carries no highlight.
      void window.api.browser
        .setGrabMode({ browserPageId: toolTargetId, enabled: false })
        .then(
          (result) => result.ok,
          () => false
        )
        .then((tornDown) => {
          // Anything since (another tool, exit, a new document, the page becoming unusable) supersedes this start.
          if (
            transitionRef.current !== transition ||
            liveOwnerRef.current !== owner ||
            !canPickRef.current
          ) {
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
          void markup.start()
        })
    },
    [cancelPendingBrowserCapture, dismissUndo, drawOwner, markup, reopenDrawing, toolTargetId]
  )

  const selectTool = useCallback(
    (tool: BrowserAnnotateTool): void => {
      if (tool === activeTool || !canPickElements) {
        return
      }
      const transition = (transitionRef.current += 1)
      setDrawStartingFor(null)
      if (tool === 'draw') {
        startDraw(transition)
        return
      }
      if (markup.isActive) {
        leaveDraw()
      }
      startGrabIntent(tool)
    },
    [activeTool, canPickElements, leaveDraw, markup.isActive, startDraw, startGrabIntent]
  )

  const exit = useCallback((): void => {
    transitionRef.current += 1
    setDrawStartingFor(null)
    if (markup.isActive) {
      leaveDraw()
      return
    }
    cancelPendingBrowserCapture()
  }, [cancelPendingBrowserCapture, leaveDraw, markup.isActive])

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

  // While Draw waits for teardown neither the picker nor the drawing owns Esc; this does.
  useEffect(() => {
    if (!drawStarting) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Same owner rule as the picker's and Draw's Esc: this page's surfaces, or no element when it was used last.
      if (
        event.key === 'Escape' &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !isEditableKeyboardTarget(event.target) &&
        annotateEscOwner(event.target) === toolTargetId
      ) {
        event.preventDefault()
        exit()
      }
    }
    // Focus sits on the palette's Draw button meanwhile (it takes focus on tool change), so the app router sees Esc.
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [drawStarting, exit, toolTargetId])

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
    drawOwner
  }
}
