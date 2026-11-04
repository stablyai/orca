import type { Editor } from '@tiptap/react'

/** Guard lazy mounts against stealing focus; force claims explicit handoffs immediately, and shouldFocus expires pending requests. */
export function autoFocusRichEditor(
  nextEditor: Editor,
  rootEl: HTMLElement | null,
  force = false,
  shouldFocus: () => boolean = () => true
): () => void {
  // Why: Tiptap can recreate the instance before its deferred focus lands, losing explicit handoffs.
  if (force && !nextEditor.isDestroyed && shouldFocus()) {
    nextEditor.view?.dom?.focus?.({ preventScroll: true })
  }
  let frameId: number | null = requestAnimationFrame(() => {
    frameId = null
    if (nextEditor.isDestroyed || !shouldFocus()) {
      return
    }
    const active = document.activeElement
    // Only explicit opens may steal focus from unrelated inputs or dialogs.
    const canTakeFocus =
      force || active === null || active === document.body || (rootEl?.contains(active) ?? false)
    if (!canTakeFocus) {
      return
    }
    // Use start for a TextSelection instead of an empty document’s AllSelection; disable scrolling to preserve tab-switch restoration.
    nextEditor.commands.focus('start', { scrollIntoView: false })
  })
  return () => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
      frameId = null
    }
  }
}
