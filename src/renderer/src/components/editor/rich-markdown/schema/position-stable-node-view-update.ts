import type { ReactNodeViewRendererOptions } from '@tiptap/react'

type NodeViewUpdate = NonNullable<ReactNodeViewRendererOptions['update']>

/** Only use for views that do not read getPos during render: Tiptap 3.22.5 already updates its live function, avoiding rerenders when earlier typing shifts positions. */
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
    return true
  }

  updateProps()
  return true
}
