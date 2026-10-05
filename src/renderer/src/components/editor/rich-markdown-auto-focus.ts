import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'

function isSelectedTabInEditorPane(active: Element | null, rootEl: HTMLElement | null): boolean {
  if (!active?.matches('[data-tab-id][data-active="true"]')) {
    return false
  }
  const body = rootEl?.closest('[data-tab-group-body-id]')
  const strip = active.closest('[data-tab-group-strip-id]')
  return Boolean(
    body?.isConnected &&
    body.getAttribute('data-worktree-id') &&
    strip &&
    body.getAttribute('data-tab-group-body-id') === strip.getAttribute('data-tab-group-strip-id') &&
    body.getAttribute('data-worktree-id') === strip.getAttribute('data-worktree-id')
  )
}

// Explicit Explorer handoffs may claim focus; ordinary mounts must leave unrelated controls alone.
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
    const canTakeFocus =
      force ||
      active === null ||
      active === document.body ||
      (rootEl?.contains(active) ?? false) ||
      isSelectedTabInEditorPane(active, rootEl)
    if (!canTakeFocus) {
      return
    }
    // An empty document's AllSelection needs a caret; restored text selections must survive.
    const focusPosition =
      force || !(nextEditor.state.selection instanceof TextSelection) ? 'start' : null
    // Cursor reveal would overwrite the separately restored scroll position.
    nextEditor.commands.focus(focusPosition, { scrollIntoView: false })
  })
  return () => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
      frameId = null
    }
  }
}
