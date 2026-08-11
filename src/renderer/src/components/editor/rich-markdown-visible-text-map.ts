import type { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model'

type RichMarkdownVisibleTextContainer = ProseMirrorNode | Fragment

export type RichMarkdownVisibleTextSegment = {
  kind: 'text' | 'read-only-atom' | 'separator'
  text: string
  from: number
  to: number
  visibleFrom: number
  visibleTo: number
}

export type RichMarkdownVisibleTextMap = {
  text: string
  segments: RichMarkdownVisibleTextSegment[]
}

export function createRichMarkdownVisibleTextMap(
  doc: RichMarkdownVisibleTextContainer,
  from = 0,
  to = getContainerContentSize(doc)
): RichMarkdownVisibleTextMap {
  const segments: RichMarkdownVisibleTextSegment[] = []
  let text = ''
  forEachRichMarkdownVisibleTextSegment(doc, from, to, (segment) => {
    const visibleFrom = text.length
    text += segment.text
    segments.push({ ...segment, visibleFrom, visibleTo: text.length })
    return true
  })
  return { text, segments }
}

export function getRichMarkdownVisibleText(
  doc: RichMarkdownVisibleTextContainer,
  from = 0,
  to = getContainerContentSize(doc)
): string {
  return createRichMarkdownVisibleTextMap(doc, from, to).text
}

export function getRichMarkdownSelectionVisibleText(state: {
  doc: ProseMirrorNode
  selection: { from: number; to: number }
}): string {
  return getRichMarkdownVisibleText(state.doc, state.selection.from, state.selection.to).trim()
}

/** Why: shared block-boundary heuristic for visible-text maps and slice byte limits. */
export function isRichMarkdownVisibleBlockStart(node: ProseMirrorNode): boolean {
  return node.isTextblock || (node.isBlock && node.isLeaf)
}

export function forEachRichMarkdownVisibleTextSegment(
  doc: RichMarkdownVisibleTextContainer,
  from: number,
  to: number,
  visit: (segment: Omit<RichMarkdownVisibleTextSegment, 'visibleFrom' | 'visibleTo'>) => boolean
): void {
  let stopped = false
  let sawVisibleBlock = false
  const inspect = (
    node: ProseMirrorNode,
    pos: number,
    parent: ProseMirrorNode | null = null,
    index = 0
  ) => {
    if (stopped) {
      return false
    }
    const startsVisibleBlock = isRichMarkdownVisibleBlockStart(node)
    if (startsVisibleBlock) {
      if (sawVisibleBlock) {
        stopped = !visit({ kind: 'separator', text: '\n', from: pos, to: pos })
        if (stopped) {
          return false
        }
      }
      sawVisibleBlock = true
      if (node.isTextblock) {
        return true
      }
    }
    let visible = ''
    let segmentFrom = pos
    let segmentTo = pos + node.nodeSize
    let kind: RichMarkdownVisibleTextSegment['kind'] = 'text'
    if (node.isText) {
      const source = node.text ?? ''
      const startOffset = Math.max(0, from - pos)
      const endOffset = Math.min(source.length, to - pos)
      if (endOffset <= startOffset) {
        return
      }
      visible = source.slice(startOffset, endOffset)
      segmentFrom = pos + startOffset
      segmentTo = pos + endOffset
    } else if (node.isLeaf) {
      visible = getRichMarkdownLeafVisibleText(node, pos, parent, index)
      kind = node.isAtom ? 'read-only-atom' : 'text'
    } else {
      return
    }
    if (!visible) {
      return
    }
    stopped = !visit({
      kind,
      text: visible,
      from: segmentFrom,
      to: segmentTo
    })
    return !stopped
  }
  doc.nodesBetween(from, to, inspect)
}

export function getRichMarkdownLeafVisibleText(
  node: ProseMirrorNode,
  pos: number,
  parent: ProseMirrorNode | null,
  index: number
): string {
  return (
    node.type.spec.toText?.({ node, pos, parent, index }) ?? node.type.spec.leafText?.(node) ?? ''
  )
}

function getContainerContentSize(container: RichMarkdownVisibleTextContainer): number {
  return 'nodeSize' in container ? container.content.size : container.size
}
