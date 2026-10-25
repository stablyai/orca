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

/** Choose the composer’s annotation block from a noncollapsed selection within this preview. */
export function getMarkdownAnnotationBlockKeyForSelection(
  root: HTMLElement,
  selection: Selection | null
): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }
  // For multi-block selections, prefer the anchor block, then the focus block.
  return (
    closestAnnotationBlockKey(selection.anchorNode, root) ??
    closestAnnotationBlockKey(selection.focusNode, root)
  )
}

export function previewHasAnnotationBlockKey(root: HTMLElement, blockKey: string): boolean {
  // Compare attributes to avoid CSS.escape, which some test environments lack.
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
    // Content renumbering can leave a stale key; only mounted composers should consume the chord.
    if (previewHasAnnotationBlockKey(root, activeAnnotationBlockKey)) {
      return { action: 'consume' }
    }
    // Clear stale keys without letting held chords open a replacement composer.
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
