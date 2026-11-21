import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { motionSafeScrollBehavior } from '@/hooks/theme/usePrefersReducedMotion'
import { revealMarkdownNavigationDetails } from '../../markdown/navigation/markdown-navigation-details'
import { flushPendingProseMirrorSelection } from '../review/rich-markdown-selection-flush'
import { scrollRichMarkdownElementIntoView } from '../viewport/rich-markdown-viewport'
import { normalizeFootnoteIdentifier } from './rich-markdown-footnote-source'

export const FOOTNOTE_REF_ATTR = 'data-rich-markdown-footnote-ref'
export const FOOTNOTE_REF_KEY_ATTR = 'data-rich-markdown-footnote-ref-key'
export const FOOTNOTE_DEF_ATTR = 'data-rich-markdown-footnote-def'
export const FOOTNOTE_DEF_KEY_ATTR = 'data-rich-markdown-footnote-def-key'

const JUMP_HIGHLIGHT_CLASS = 'rich-markdown-footnote-jump-target'
const JUMP_HIGHLIGHT_DURATION_MS = 1400
const highlightTimers = new WeakMap<HTMLElement, number>()

function flashFootnoteJumpTarget(element: HTMLElement): void {
  const previousTimer = highlightTimers.get(element)
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer)
  }
  element.classList.remove(JUMP_HIGHLIGHT_CLASS)
  // Force a style flush only when restarting an active highlight.
  if (previousTimer !== undefined) {
    void element.offsetWidth
  }
  element.classList.add(JUMP_HIGHLIGHT_CLASS)
  const timer = window.setTimeout(() => {
    element.classList.remove(JUMP_HIGHLIGHT_CLASS)
    highlightTimers.delete(element)
  }, JUMP_HIGHLIGHT_DURATION_MS)
  highlightTimers.set(element, timer)
}

function findElementByKeyAttribute(
  root: HTMLElement,
  attribute: string,
  normalizedKey: string
): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>(`[${attribute}]`)
  for (const candidate of candidates) {
    if (candidate.getAttribute(attribute) === normalizedKey) {
      return candidate
    }
  }
  return null
}

function scrollAndHighlightTarget(target: HTMLElement): boolean {
  revealMarkdownNavigationDetails(target)
  scrollRichMarkdownElementIntoView(target, {
    behavior: motionSafeScrollBehavior(),
    block: 'center'
  })
  flashFootnoteJumpTarget(target)
  return true
}

export function scrollToFootnoteDefinition(root: HTMLElement | null, identifier: string): boolean {
  if (!root || !identifier) {
    return false
  }
  const target = findElementByKeyAttribute(
    root,
    FOOTNOTE_DEF_KEY_ATTR,
    normalizeFootnoteIdentifier(identifier)
  )
  return target ? scrollAndHighlightTarget(target) : false
}

export function scrollToFootnoteReference(root: HTMLElement | null, identifier: string): boolean {
  if (!root || !identifier) {
    return false
  }
  const target = findElementByKeyAttribute(
    root,
    FOOTNOTE_REF_KEY_ATTR,
    normalizeFootnoteIdentifier(identifier)
  )
  return target ? scrollAndHighlightTarget(target) : false
}

function getSelectedFootnoteReferenceIdentifier(editor: Editor): string | null {
  let selection = editor.state?.selection
  if (!selection) {
    return null
  }
  if (
    selection.empty &&
    typeof window !== 'undefined' &&
    window.getSelection()?.isCollapsed === false
  ) {
    // Rapid Shift+Arrow selection over an inline atom can precede ProseMirror's DOM observer sync.
    flushPendingProseMirrorSelection(editor)
    selection = editor.state?.selection
    if (!selection) {
      return null
    }
  }
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === 'richMarkdownFootnoteReference'
  ) {
    return String(selection.node.attrs.identifier ?? '') || null
  }
  if (selection.to - selection.from === 1) {
    const selectedNode = editor.state.doc.nodeAt(selection.from)
    if (selectedNode?.type.name === 'richMarkdownFootnoteReference') {
      return String(selectedNode.attrs.identifier ?? '') || null
    }
  }
  return null
}

export function jumpToSelectedFootnoteDefinition(
  editor: Editor | null,
  root: HTMLElement | null
): boolean {
  if (!editor) {
    return false
  }
  const identifier = getSelectedFootnoteReferenceIdentifier(editor)
  if (!identifier) {
    return false
  }
  scrollToFootnoteDefinition(root ?? editor.view.dom, identifier)
  return true
}

export function exitTrailingEmptyFootnoteParagraph(editor: Editor): boolean {
  const { state, view } = editor
  const { selection } = state
  const { $from, empty } = selection

  if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size !== 0) {
    return false
  }

  const defDepth = $from.depth - 1
  if (defDepth < 1) {
    return false
  }
  const defNode = $from.node(defDepth)
  if (
    defNode.type.name !== 'richMarkdownFootnoteDefinition' ||
    $from.index(defDepth) !== defNode.childCount - 1
  ) {
    return false
  }

  const paragraph = state.schema.nodes.paragraph?.createAndFill()
  if (!paragraph) {
    return false
  }

  const currentBlockFrom = $from.before($from.depth)
  const currentBlockTo = $from.after($from.depth)
  const shouldRemoveTrailingEmptyBlock = defNode.childCount > 1
  let insertPos = $from.after(defDepth)
  const tr = state.tr

  if (shouldRemoveTrailingEmptyBlock) {
    tr.delete(currentBlockFrom, currentBlockTo)
    insertPos -= currentBlockTo - currentBlockFrom
  }

  tr.insert(insertPos, paragraph)
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
  tr.scrollIntoView()
  view.dispatch(tr)
  return true
}

export function unwrapEmptyFootnoteDefinition(editor: Editor): boolean {
  const { state, view } = editor
  const { selection } = state
  const { $from, empty } = selection

  if (
    !empty ||
    $from.parent.type.name !== 'paragraph' ||
    $from.parentOffset !== 0 ||
    $from.parent.content.size !== 0
  ) {
    return false
  }

  const defDepth = $from.depth - 1
  if (defDepth < 1) {
    return false
  }
  const defNode = $from.node(defDepth)
  if (
    defNode.type.name !== 'richMarkdownFootnoteDefinition' ||
    defNode.childCount !== 1 ||
    $from.index(defDepth) !== 0
  ) {
    return false
  }

  const paragraph = state.schema.nodes.paragraph?.createAndFill()
  if (!paragraph) {
    return false
  }

  const defFrom = $from.before(defDepth)
  const defTo = $from.after(defDepth)
  const tr = state.tr.replaceWith(defFrom, defTo, paragraph)
  tr.setSelection(TextSelection.create(tr.doc, defFrom + 1))
  tr.scrollIntoView()
  view.dispatch(tr)
  return true
}
