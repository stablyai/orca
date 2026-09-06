export function removeTerminalRichInputNode({
  deleteNode,
  focusEditor,
  getPosition,
  schedule = requestAnimationFrame,
  deleteAtPosition
}: {
  deleteNode: () => void
  focusEditor: (position: number) => void
  getPosition: () => number | undefined
  schedule?: (callback: FrameRequestCallback) => number
  deleteAtPosition?: (position: number) => boolean
}): void {
  const position = getPosition()
  if (position === undefined || !deleteAtPosition?.(position)) {
    deleteNode()
  }
  if (position === undefined) {
    return
  }
  schedule(() => focusEditor(position))
}
