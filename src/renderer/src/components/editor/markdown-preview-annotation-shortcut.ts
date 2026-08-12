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

export function previewHasAnnotationBlockKey(root: HTMLElement, blockKey: string): boolean {
  // Why: walk attributes instead of building a CSS selector so keys never need
  // CSS.escape (unavailable in some test environments).
  for (const block of root.querySelectorAll('[data-annotation-block-key]')) {
    if (block.getAttribute('data-annotation-block-key') === blockKey) {
      return true
    }
  }
  return false
}

export type MarkdownPreviewAddReviewNoteKeyResult =
  | { action: 'ignore' }
  | { action: 'consume' }
  | { action: 'open'; blockKey: string }
  | { action: 'clear-stale-and-ignore' }

/**
 * Pure decision for the preview add-review-note chord. Keeps product B, OS
 * key-repeat, and stale-block-key handling out of the React component body.
 */
export function resolveMarkdownPreviewAddReviewNoteKey(options: {
  event: Pick<
    KeyboardEvent,
    'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'
  >
  platform: NodeJS.Platform
  keybindings?: KeybindingOverrides
  targetInsidePreview: boolean
  markdownAnnotationsEnabled: boolean
  activeAnnotationBlockKey: string | null
  root: HTMLElement
  selection: Selection | null
}): MarkdownPreviewAddReviewNoteKeyResult {
  const {
    event,
    platform,
    keybindings,
    targetInsidePreview,
    markdownAnnotationsEnabled,
    activeAnnotationBlockKey,
    root,
    selection
  } = options

  if (
    !isMarkdownPreviewAddReviewNoteShortcut(event, platform, keybindings) ||
    !targetInsidePreview ||
    !markdownAnnotationsEnabled
  ) {
    return { action: 'ignore' }
  }

  if (activeAnnotationBlockKey) {
    // Why: only treat the key as an open draft when the block still mounts a
    // composer; a stale key after content renumber must not lock the shortcut.
    if (previewHasAnnotationBlockKey(root, activeAnnotationBlockKey)) {
      return { action: 'consume' }
    }
    // Fall through after clearing so a held/stale key does not permanently
    // suppress open. Repeat still must not open (below).
    if (event.repeat) {
      return { action: 'clear-stale-and-ignore' }
    }
    const blockKey = getMarkdownAnnotationBlockKeyForSelection(root, selection)
    if (blockKey) {
      return { action: 'open', blockKey }
    }
    return { action: 'clear-stale-and-ignore' }
  }

  // Why: ignore OS key-repeat so a held chord cannot thrash open without a draft.
  if (event.repeat) {
    return { action: 'ignore' }
  }

  const blockKey = getMarkdownAnnotationBlockKeyForSelection(root, selection)
  if (blockKey) {
    return { action: 'open', blockKey }
  }
  return { action: 'ignore' }
}
