import type { IRange } from 'monaco-editor'

export function selectionSide(node: Node): 'additions' | 'deletions' | null {
  const element = node instanceof Element ? node : node.parentElement
  const code = element?.closest('[data-code]')
  const type = element?.closest('[data-line]')?.getAttribute('data-line-type')
  if (code?.hasAttribute('data-deletions') || type === 'change-deletion') {
    return 'deletions'
  }
  if (code?.hasAttribute('data-additions') || type === 'change-addition') {
    return 'additions'
  }
  return null
}

function selectionBoundary(node: Node, offset: number): { line: number; column: number } | null {
  const element = node instanceof Element ? node : node.parentElement
  const row = element?.closest('[data-line]')
  const line = Number(row?.getAttribute('data-line'))
  if (!row || !Number.isInteger(line) || line < 1) {
    return null
  }
  const prefix = document.createRange()
  prefix.selectNodeContents(row)
  prefix.setEnd(node, offset)
  return { line, column: prefix.toString().length + 1 }
}

// DOM ranges are ordered even when the user drags backwards.
export function getPierreSelectionRange(selection: Selection | null): IRange | null {
  if (!selection?.rangeCount) {
    return null
  }
  const range = selection.getRangeAt(0)
  let side = selectionSide(range.startContainer) ?? selectionSide(range.endContainer)
  const ancestor = range.commonAncestorContainer
  if (ancestor instanceof Element || ancestor instanceof ShadowRoot) {
    for (const row of ancestor.querySelectorAll('[data-line]')) {
      if (!range.intersectsNode(row)) {
        continue
      }
      const rowSide = selectionSide(row)
      if (side && rowSide && side !== rowSide) {
        return null
      }
      side ??= rowSide
    }
  }
  const start = selectionBoundary(range.startContainer, range.startOffset)
  const end = selectionBoundary(range.endContainer, range.endOffset)
  if (!start || !end) {
    return null
  }
  return {
    startLineNumber: start.line,
    startColumn: start.column,
    endLineNumber: end.line,
    endColumn: end.column
  }
}
