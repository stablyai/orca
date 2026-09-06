import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'
import {
  TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
  TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER
} from './terminal-rich-input-model'

type TerminalRichInputImageRange = { from: number; to: number }
type TerminalRichInputImageDeleteDirection = 'backward' | 'forward'

export function deleteTerminalRichInputImageAt(editor: Editor, position: number): boolean {
  const range = terminalRichInputImageRangeAt(editor.state.doc, position)
  return range ? editor.commands.deleteRange(range) : false
}

export function deleteTerminalRichInputImageAtSelection(
  editor: Editor,
  direction: TerminalRichInputImageDeleteDirection
): boolean {
  const { selection } = editor.state
  let position: number | null = null
  if (!selection.empty) {
    const selectedNode = editor.state.doc.nodeAt(selection.from)
    if (
      selectedNode?.type.name === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE &&
      selection.to === selection.from + selectedNode.nodeSize
    ) {
      position = selection.from
    }
  } else if (direction === 'forward') {
    position = selection.from
  } else {
    const nodeBefore = selection.$from.nodeBefore
    if (nodeBefore?.type.name === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE) {
      position = selection.from - nodeBefore.nodeSize
    } else if (nodeBefore?.isText && nodeBefore.text === TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER) {
      const imageEnd = selection.from - nodeBefore.nodeSize
      const imageBefore = editor.state.doc.resolve(imageEnd).nodeBefore
      if (imageBefore?.type.name === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE) {
        position = imageEnd - imageBefore.nodeSize
      }
    }
  }
  return position === null ? false : deleteTerminalRichInputImageAt(editor, position)
}

function terminalRichInputImageRangeAt(
  doc: ProseMirrorNode,
  position: number
): TerminalRichInputImageRange | null {
  const image = doc.nodeAt(position)
  if (image?.type.name !== TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE) {
    return null
  }
  const imageEnd = position + image.nodeSize
  const nodeAfter = doc.nodeAt(imageEnd)
  const hasCaretSpacer = Boolean(
    nodeAfter?.isText && nodeAfter.text?.startsWith(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER)
  )
  return { from: position, to: imageEnd + (hasCaretSpacer ? 1 : 0) }
}
