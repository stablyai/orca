import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import type {
  BrowserAnnotateToolKey,
  GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { GrabModeHook } from '../grab/useGrabMode'
import type { MarkupModeController, MarkupResumeSnapshot } from '../capture/useMarkupMode'
import type { MarkupShape } from '../drawing/markup-drawing-model'

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
  toolTargetId
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
}): BrowserAnnotateToolSwitch {
  // Why: between stopping the picker and Draw's capture starting, neither is on; keep the palette on Draw meanwhile.
  // Keyed by page: a page change (preview grant swap, navigation to another tab) drops a pending Draw by itself.
  const [drawStartingFor, setDrawStartingFor] = useState<string | null>(null)
  const drawStarting = drawStartingFor !== null && drawStartingFor === toolTargetId
  const activeTool = getBrowserAnnotateActiveTool(
    grab.state,
    grabIntent,
    markup.isActive,
    drawStarting
  )
  // Fences a Draw start still waiting for teardown: any later transition, a page change or unmount supersedes it.
  const transitionRef = useRef(0)
  const shapesRef = useRef<readonly MarkupShape[]>([])
  const [restoredShapes, setRestoredShapes] = useState<readonly MarkupShape[] | undefined>()
  const undoToastRef = useRef<string | number | null>(null)
  useEffect(() => {
    return () => {
      transitionRef.current += 1
      // An Undo from another page would reopen a stale screenshot.
      if (undoToastRef.current !== null) {
        toast.dismiss(undoToastRef.current)
        undoToastRef.current = null
      }
    }
  }, [toolTargetId])

  const reportShapes = useCallback((shapes: readonly MarkupShape[]): void => {
    shapesRef.current = shapes
  }, [])

  const reopenDrawing = useCallback(
    (saved: MarkupResumeSnapshot, shapes: readonly MarkupShape[]): void => {
      undoToastRef.current = null
      transitionRef.current += 1
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
    undoToastRef.current = toast(
      translate('browser.annotatePalette.drawingDiscarded', 'Drawing discarded'),
      {
        duration: DISCARDED_DRAWING_UNDO_MS,
        action: {
          label: translate('browser.annotatePalette.undo', 'Undo'),
          onClick: () => reopenDrawing(saved, shapes)
        }
      }
    )
  }, [markup, reopenDrawing])

  const startDraw = useCallback(
    (transition: number): void => {
      setDrawStartingFor(toolTargetId)
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
          if (transitionRef.current !== transition) {
            return
          }
          setDrawStartingFor(null)
          setRestoredShapes(undefined)
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
    [cancelPendingBrowserCapture, markup, toolTargetId]
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
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        exit()
      }
    }
    // Focus sits on the palette's Draw button meanwhile (it takes focus on tool change), so the app router sees Esc.
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [drawStarting, exit])

  return {
    activeTool,
    selectTool,
    toggleTool,
    selectToolByKey,
    exit,
    toolTargetId,
    reportShapes,
    restoredShapes
  }
}
