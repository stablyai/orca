import type { ReactNodeViewRendererOptions } from '@tiptap/react'

type NodeViewUpdate = NonNullable<ReactNodeViewRendererOptions['update']>

/**
 * Tiptap re-renders a React node view whenever its document position changes,
 * even when the node and its decorations are untouched (`@tiptap/react` 3.22.5,
 * ReactNodeView.update). Typing anywhere shifts the position of every node after
 * the caret, so one keystroke in a document with N node views costs N React
 * renders — the dominant per-keystroke cost in large Markdown files.
 *
 * That re-render only exists so a component can observe a fresh `getPos()`.
 * Node views that never read `getPos` can skip it. Position bookkeeping still
 * happens in Tiptap before this runs, so `getPos()` stays correct for callers
 * that invoke it later (it is passed as a live function, not a captured value).
 *
 * Only use this for components that do not read `getPos` during render.
 */
export const positionStableNodeViewUpdate: NodeViewUpdate = ({
  oldNode,
  oldDecorations,
  oldInnerDecorations,
  newNode,
  newDecorations,
  innerDecorations,
  updateProps
}) => {
  if (
    oldNode === newNode &&
    oldDecorations === newDecorations &&
    oldInnerDecorations === innerDecorations
  ) {
    // Why: nothing this component renders from has changed — only its position.
    return true
  }

  updateProps()
  return true
}
