import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'

export function isMarkdownPreviewAddReviewNoteShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  return keybindingMatchesAction('editor.addReviewNote', event, platform, keybindings)
}

function closestAnnotationBlockKey(node: Node | null, root: HTMLElement): string | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  const block = element?.closest('[data-annotation-block-key]') ?? null
  if (!block || !root.contains(block)) {
    return null
  }
  return block.getAttribute('data-annotation-block-key')
}

/**
 * Maps the current DOM text selection to the annotation block that should host
 * the review-note composer. Returns null when the selection is collapsed or
 * falls outside an annotatable block of this preview root.
 */
export function getMarkdownAnnotationBlockKeyForSelection(
  root: HTMLElement,
  selection: Selection | null
): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }
  // Why: a selection spanning multiple blocks anchors the composer on the
  // block where the selection started, falling back to where it ended.
  return (
    closestAnnotationBlockKey(selection.anchorNode, root) ??
    closestAnnotationBlockKey(selection.focusNode, root)
  )
}
