import type { Editor } from '@tiptap/react'
import { Fragment, type Node as PmNode, type Schema } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'

const BLOCKED_CONTAINER_TYPES = new Set(['listItem', 'taskItem', 'tableCell', 'tableHeader'])
const PARAGRAPH_JOIN_NEIGHBOR_TYPES = new Set(['paragraph', 'heading'])

function isEmptyParagraph(node: PmNode | null | undefined): boolean {
  return node?.type.name === 'paragraph' && node.content.size === 0
}

function hasSoftNewline(node: PmNode): boolean {
  return node.textContent.includes('\n')
}

function setSelectionNear(tr: Transaction, pos: number): void {
  const clampedPos = Math.max(0, Math.min(pos, tr.doc.content.size))
  tr.setSelection(TextSelection.near(tr.doc.resolve(clampedPos)))
}

type TextblockBoundary = {
  after: PmNode | null
  before: PmNode | null
  current: PmNode
  currentEnd: number
  currentStart: number
}

function getTextblockBoundary(editor: Editor): TextblockBoundary | null {
  const { selection } = editor.state
  if (!selection.empty || !selection.$from.parent.isTextblock) {
    return null
  }

  const { $from } = selection
  const textblockDepth = $from.depth
  for (let depth = 1; depth < textblockDepth; depth += 1) {
    if (BLOCKED_CONTAINER_TYPES.has($from.node(depth).type.name)) {
      return null
    }
  }

  const parentIndex = $from.index(textblockDepth - 1)
  const container = $from.node(textblockDepth - 1)
  return {
    after: container.maybeChild(parentIndex + 1) ?? null,
    before: container.maybeChild(parentIndex - 1) ?? null,
    current: $from.parent,
    currentEnd: $from.after(textblockDepth),
    currentStart: $from.before(textblockDepth)
  }
}

type SoftNewlineJoin = {
  nodes: PmNode[]
  selectionOffset: number
}

function splitParagraphAtFirstSoftNewline(
  paragraph: PmNode,
  schema: Schema
): { after: Fragment; before: Fragment } | null {
  const beforeNodes: PmNode[] = []
  const afterNodes: PmNode[] = []
  let foundSoftNewline = false

  paragraph.content.forEach((child) => {
    if (foundSoftNewline) {
      afterNodes.push(child)
      return
    }

    if (!child.isText || !child.text?.includes('\n')) {
      beforeNodes.push(child)
      return
    }

    const newlineIndex = child.text.indexOf('\n')
    if (newlineIndex > 0) {
      beforeNodes.push(schema.text(child.text.slice(0, newlineIndex), child.marks))
    }
    if (newlineIndex + 1 < child.text.length) {
      afterNodes.push(schema.text(child.text.slice(newlineIndex + 1), child.marks))
    }
    foundSoftNewline = true
  })

  if (!foundSoftNewline) {
    return null
  }

  return {
    after: Fragment.fromArray(afterNodes),
    before: Fragment.fromArray(beforeNodes)
  }
}

function createSoftNewlineJoin(
  left: PmNode,
  right: PmNode,
  schema: Schema
): SoftNewlineJoin | null {
  if (left.type.name === 'paragraph' && PARAGRAPH_JOIN_NEIGHBOR_TYPES.has(right.type.name)) {
    if (!hasSoftNewline(left) && (right.type.name !== 'paragraph' || !hasSoftNewline(right))) {
      return null
    }

    // Why: ProseMirror Transform.join substitutes paragraph text `\n` with
    // hardBreak nodes at textblock boundaries, which makes hard-wrapped prose narrow.
    const content = left.content.append(right.content)
    if (!left.type.validContent(content)) {
      return null
    }

    return {
      nodes: [left.type.create(left.attrs, content, left.marks)],
      selectionOffset: left.content.size
    }
  }

  if (left.type.name !== 'heading' || right.type.name !== 'paragraph' || !hasSoftNewline(right)) {
    return null
  }

  const split = splitParagraphAtFirstSoftNewline(right, schema)
  if (!split) {
    return null
  }

  const headingContent = left.content.append(split.before)
  if (!left.type.validContent(headingContent)) {
    return null
  }

  const nodes = [left.type.create(left.attrs, headingContent, left.marks)]
  if (split.after.size > 0) {
    if (!right.type.validContent(split.after)) {
      return null
    }
    nodes.push(right.type.create(right.attrs, split.after, right.marks))
  }

  return {
    nodes,
    selectionOffset: left.content.size
  }
}

function dispatchSoftNewlineJoin(
  editor: Editor,
  from: number,
  to: number,
  join: SoftNewlineJoin
): void {
  const tr = editor.state.tr.replaceWith(from, to, join.nodes)
  setSelectionNear(tr, from + 1 + join.selectionOffset)
  editor.view.dispatch(tr)
}

export function deleteAdjacentEmptyParagraph(editor: Editor, direction: 'backward' | 'forward') {
  const boundary = getTextblockBoundary(editor)
  if (!boundary) {
    return false
  }

  const { selection } = editor.state
  const { $from } = selection
  const { after, before, current, currentEnd, currentStart } = boundary

  if (direction === 'backward') {
    if ($from.parentOffset !== 0) {
      return false
    }

    if (isEmptyParagraph(current)) {
      if (!before) {
        return false
      }
      // Why: ProseMirror's default Backspace join converts soft `\n` text in
      // the previous paragraph into hardBreak nodes. Delete the blank block only.
      const tr = editor.state.tr.delete(currentStart, currentEnd)
      setSelectionNear(tr, currentStart - 1)
      editor.view.dispatch(tr)
      return true
    }

    if (before && isEmptyParagraph(before)) {
      const from = currentStart - before.nodeSize
      const tr = editor.state.tr.delete(from, currentStart)
      setSelectionNear(tr, tr.mapping.map(selection.from, -1))
      editor.view.dispatch(tr)
      return true
    }

    if (before && current.isTextblock && before.isTextblock) {
      const join = createSoftNewlineJoin(before, current, editor.state.schema)
      if (!join) {
        return false
      }
      const from = currentStart - before.nodeSize
      dispatchSoftNewlineJoin(editor, from, currentEnd, join)
      return true
    }

    return false
  }

  if ($from.parentOffset !== current.content.size) {
    return false
  }

  if (isEmptyParagraph(current)) {
    if (!after) {
      return false
    }
    const tr = editor.state.tr.delete(currentStart, currentEnd)
    setSelectionNear(tr, currentStart)
    editor.view.dispatch(tr)
    return true
  }

  if (after && isEmptyParagraph(after)) {
    // Why: Delete at the end of a soft-wrapped paragraph should remove the
    // blank line without running ProseMirror's newline-to-hardBreak join path.
    const tr = editor.state.tr.delete(currentEnd, currentEnd + after.nodeSize)
    setSelectionNear(tr, currentEnd - 1)
    editor.view.dispatch(tr)
    return true
  }

  if (after && current.isTextblock && after.isTextblock) {
    const join = createSoftNewlineJoin(current, after, editor.state.schema)
    if (!join) {
      return false
    }
    dispatchSoftNewlineJoin(editor, currentStart, currentEnd + after.nodeSize, join)
    return true
  }

  return false
}
