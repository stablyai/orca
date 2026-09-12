import type { Editor } from '@tiptap/react'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { formatNativeChatFileReference } from '../native-chat/native-chat-composer-target'
import {
  TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
  TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
  TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER,
  terminalRichInputContentToClipboardText
} from './terminal-rich-input-model'

type EditorRef = { readonly current: Editor | null }

const clipboardToken = createBrowserUuid()
const selectionDrags = new WeakSet<EditorView>()

export function terminalRichInputClipboardProps(editorRef: EditorRef): {
  clipboardTextSerializer: () => string
  transformCopied: (slice: Slice) => Slice
  transformPasted: (slice: Slice) => Slice
  decorations: (state: EditorState) => DecorationSet
  handleDOMEvents: {
    cut: (view: EditorView) => false
    mousedown: (view: EditorView) => false
  }
} {
  return {
    clipboardTextSerializer: () => terminalRichInputClipboardText(editorRef.current),
    transformCopied: (slice) => markTerminalRichInputClipboardNodes(slice, clipboardToken),
    transformPasted: (slice) => prepareTerminalRichInputPastedSlice(slice, clipboardToken),
    decorations: (state) =>
      editorRef.current && selectionDrags.has(editorRef.current.view)
        ? DecorationSet.empty
        : selectedTerminalRichInputChips(state),
    handleDOMEvents: {
      cut: (view) => expandImageCutSelection(view),
      mousedown: (view) => {
        selectionDrags.add(view)
        window.addEventListener('mouseup', () => finishSelectionDrag(view), { once: true })
        return false
      }
    }
  }
}

export function terminalRichInputClipboardText(editor: Editor | null): string {
  return terminalRichInputContentToClipboardText({
    type: 'doc',
    content: editor?.state.selection.content().content.toJSON() ?? []
  })
}

export function rekeyTerminalRichInputPastedImages(
  slice: Slice,
  createId: () => string = createBrowserUuid
): Slice {
  return new Slice(rekeyImageNodes(slice.content, createId), slice.openStart, slice.openEnd)
}

function markTerminalRichInputClipboardNodes(slice: Slice, token: string): Slice {
  return new Slice(markClipboardNodes(slice.content, token), slice.openStart, slice.openEnd)
}

function prepareTerminalRichInputPastedSlice(slice: Slice, token: string): Slice {
  const sanitized = sanitizePastedNodes(slice.content, token)
  return new Slice(rekeyImageNodes(sanitized), slice.openStart, slice.openEnd)
}

function finishSelectionDrag(view: EditorView): void {
  requestAnimationFrame(() => {
    selectionDrags.delete(view)
    if (view.dom.isConnected) {
      view.dispatch(view.state.tr.setMeta('terminal-rich-input-selection', true))
    }
  })
}

function expandImageCutSelection(view: EditorView): false {
  const { selection } = view.state
  const selectedImageEndsAtTo =
    (selection instanceof NodeSelection &&
      selection.node.type.name === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE) ||
    selection.$to.nodeBefore?.type.name === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE
  const next = view.state.doc.nodeAt(selection.to)
  if (
    selectedImageEndsAtTo &&
    next?.isText &&
    next.text?.startsWith(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER)
  ) {
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, selection.from, selection.to + 1)
      )
    )
  }
  return false
}

function selectedTerminalRichInputChips(state: EditorState): DecorationSet {
  const { selection } = state
  if (selection.empty || selection instanceof NodeSelection) {
    return DecorationSet.empty
  }
  const decorations: Decoration[] = []
  state.doc.nodesBetween(selection.from, selection.to, (node, position) => {
    const nodeEnd = position + node.nodeSize
    const fullySelected = selection.from <= position && selection.to >= nodeEnd
    const contentFullySelected =
      !node.isLeaf && selection.from <= position + 1 && selection.to >= nodeEnd - 1
    if (node.type.name === 'paragraph' && contentFullySelected) {
      decorations.push(
        Decoration.node(position, nodeEnd, { class: 'terminal-rich-input-block-selected' })
      )
    }
    const isChip =
      node.type.name === TERMINAL_RICH_INPUT_FILE_MENTION_NODE ||
      node.type.name === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE
    if (isChip && fullySelected) {
      decorations.push(
        Decoration.node(position, nodeEnd, { class: 'terminal-rich-input-range-selected' })
      )
    }
  })
  return DecorationSet.create(state.doc, decorations)
}

function markClipboardNodes(fragment: Fragment, token: string): Fragment {
  const nodes: ProseMirrorNode[] = []
  fragment.forEach((node) => {
    const content = node.content.size ? markClipboardNodes(node.content, token) : node.content
    const isResource =
      node.type.name === TERMINAL_RICH_INPUT_FILE_MENTION_NODE ||
      node.type.name === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE
    nodes.push(
      isResource
        ? node.type.create({ ...node.attrs, clipboardToken: token }, content, node.marks)
        : node.copy(content)
    )
  })
  return Fragment.fromArray(nodes)
}

function sanitizePastedNodes(fragment: Fragment, token: string): Fragment {
  const nodes: ProseMirrorNode[] = []
  let stripLeadingSpacer = false
  fragment.forEach((node) => {
    const stripSpacer = stripLeadingSpacer
    stripLeadingSpacer = false
    if (
      node.isText &&
      stripSpacer &&
      node.text?.startsWith(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER)
    ) {
      const text = node.text.slice(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER.length)
      if (text) {
        nodes.push(node.type.schema.text(text, node.marks))
      }
      return
    }
    const isFile = node.type.name === TERMINAL_RICH_INPUT_FILE_MENTION_NODE
    const isImage = node.type.name === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE
    if ((isFile || isImage) && node.attrs.clipboardToken !== token) {
      nodes.push(
        node.type.schema.text(formatNativeChatFileReference(String(node.attrs.path ?? '')))
      )
      stripLeadingSpacer = isImage
      return
    }
    const content = node.content.size ? sanitizePastedNodes(node.content, token) : node.content
    nodes.push(
      isFile || isImage
        ? node.type.create({ ...node.attrs, clipboardToken: null }, content, node.marks)
        : node.copy(content)
    )
  })
  return Fragment.fromArray(nodes)
}

function rekeyImageNodes(fragment: Fragment, createId: () => string = createBrowserUuid): Fragment {
  const source: ProseMirrorNode[] = []
  fragment.forEach((node) => source.push(node))
  const nodes: ProseMirrorNode[] = []
  source.forEach((node, index) => {
    const content = node.content.size ? rekeyImageNodes(node.content, createId) : node.content
    if (node.type.name !== TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE) {
      nodes.push(node.copy(content))
      return
    }
    nodes.push(node.type.create({ ...node.attrs, id: createId() }, content, node.marks))
    const next = source[index + 1]
    if (!next?.isText || !next.text?.startsWith(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER)) {
      nodes.push(node.type.schema.text(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER))
    }
  })
  return Fragment.fromArray(nodes)
}
