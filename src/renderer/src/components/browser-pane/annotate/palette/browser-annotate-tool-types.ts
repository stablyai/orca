import type {
  BrowserAnnotateToolKey,
  GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { GrabModeHook } from '../grab/useGrabMode'
import type { MarkupShape } from '../drawing/markup-drawing-model'

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

export const TOOL_BY_KEY: Record<BrowserAnnotateToolKey, BrowserAnnotateTool> = {
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
