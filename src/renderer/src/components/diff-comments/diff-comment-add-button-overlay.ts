import * as monaco from 'monaco-editor'
import type { editor as monacoEditor, IDisposable } from 'monaco-editor'
import type { RefObject } from 'react'
import { getDiffCommentPopoverTop } from './diff-comment-popover-position'

// Monaco glyph decorations don't expose usable click events, so we own an absolutely-positioned "+" button that follows the hovered line.

type AddButtonOverlayArgs = {
  editor: monacoEditor.ICodeEditor
  editorDomNode: HTMLElement
  addButtonLabel: string
  commentableLineSet: Set<number> | null
  // Refs, not locals: they must survive the model-swap rebuild of the overlay.
  hoverLineRef: RefObject<number | null>
  disposablesRef: RefObject<IDisposable[]>
  onAddCommentClickRef: RefObject<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >
}

export function installDiffCommentAddButtonOverlay({
  editor,
  editorDomNode,
  addButtonLabel,
  commentableLineSet,
  hoverLineRef,
  disposablesRef,
  onAddCommentClickRef
}: AddButtonOverlayArgs): () => void {
  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'orca-diff-comment-add-btn'
  plus.title = addButtonLabel
  plus.setAttribute('aria-label', addButtonLabel)
  plus.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'
  plus.style.display = 'none'
  editorDomNode.appendChild(plus)

  const getLineHeight = (): number => {
    const h = editor.getOption(monaco.editor.EditorOption.lineHeight)
    return typeof h === 'number' && h > 0 ? h : 19
  }

  // Cache last-applied styles so positionAtLine skips redundant DOM writes on high-freq mousemove (restyling under the cursor flickers).
  let lastTop: number | null = null
  let lastDisplay: string | null = null

  const setDisplay = (value: string): void => {
    if (lastDisplay === value) {
      return
    }
    plus.style.display = value
    lastDisplay = value
  }

  // Fixed 18px square centered in the line box — tracking line-height made a rectangle on taller line-heights.
  const BUTTON_SIZE = 18
  let rangeDecorationIds: string[] = []
  let dragState: { startLine: number; endLine: number } | null = null

  const clearRangeDecoration = (): void => {
    if (rangeDecorationIds.length > 0) {
      rangeDecorationIds = editor.deltaDecorations(rangeDecorationIds, [])
    }
  }

  const updateRangeDecoration = (startLine: number, endLine: number): void => {
    const from = Math.min(startLine, endLine)
    const to = Math.max(startLine, endLine)
    rangeDecorationIds = editor.deltaDecorations(rangeDecorationIds, [
      {
        range: new monaco.Range(from, 1, to, 1),
        options: {
          isWholeLine: true,
          className: 'orca-diff-comment-range-highlight'
        }
      }
    ])
  }

  const getLineAtClientPoint = (clientX: number, clientY: number): number | null => {
    return editor.getTargetAtClientPoint(clientX, clientY)?.position?.lineNumber ?? null
  }

  const canCommentOnLine = (lineNumber: number): boolean => {
    return commentableLineSet === null || commentableLineSet.has(lineNumber)
  }

  const canCommentOnRange = (startLine: number, endLine: number): boolean => {
    if (commentableLineSet === null) {
      return true
    }
    const from = Math.min(startLine, endLine)
    const to = Math.max(startLine, endLine)
    for (let line = from; line <= to; line++) {
      if (!commentableLineSet.has(line)) {
        return false
      }
    }
    return true
  }

  const positionAtLine = (lineNumber: number): void => {
    const lineTop = editor.getTopForLineNumber(lineNumber) - editor.getScrollTop()
    const top = Math.round(lineTop + (getLineHeight() - BUTTON_SIZE) / 2)
    if (top !== lastTop) {
      plus.style.top = `${top}px`
      lastTop = top
    }
    setDisplay('flex')
  }

  const finishRangeDrag = (ev: MouseEvent): void => {
    ev.preventDefault()
    ev.stopPropagation()
    document.removeEventListener('mousemove', handleRangeDragMove)
    document.removeEventListener('mouseup', finishRangeDrag)
    const currentDrag = dragState
    dragState = null
    clearRangeDecoration()
    if (!currentDrag) {
      return
    }
    if (!canCommentOnRange(currentDrag.startLine, currentDrag.endLine)) {
      return
    }
    const startLine = Math.min(currentDrag.startLine, currentDrag.endLine)
    const lineNumber = Math.max(currentDrag.startLine, currentDrag.endLine)
    const top = getDiffCommentPopoverTop(editor, lineNumber, getLineHeight())
    if (top == null) {
      return
    }
    onAddCommentClickRef.current({
      lineNumber,
      startLine: startLine === lineNumber ? undefined : startLine,
      top
    })
  }

  const handleRangeDragMove = (ev: MouseEvent): void => {
    if (!dragState) {
      return
    }
    const line = getLineAtClientPoint(ev.clientX, ev.clientY)
    if (
      line == null ||
      line === dragState.endLine ||
      !canCommentOnLine(line) ||
      !canCommentOnRange(dragState.startLine, line)
    ) {
      return
    }
    dragState = { ...dragState, endLine: line }
    updateRangeDecoration(dragState.startLine, line)
  }

  const handleMouseDown = (ev: MouseEvent): void => {
    ev.preventDefault()
    ev.stopPropagation()
    const line = hoverLineRef.current
    if (line == null || !canCommentOnLine(line)) {
      return
    }
    dragState = { startLine: line, endLine: line }
    updateRangeDecoration(line, line)
    document.addEventListener('mousemove', handleRangeDragMove)
    document.addEventListener('mouseup', finishRangeDrag)
  }
  plus.addEventListener('mousedown', handleMouseDown)

  const onMouseMove = editor.onMouseMove((e) => {
    // Monaco reports null position over our "+" button; hiding on null would flicker-loop, so keep it visible while the cursor's on it.
    const srcEvent = e.event?.browserEvent as MouseEvent | undefined
    if (srcEvent && plus.contains(srcEvent.target as Node)) {
      return
    }
    const ln = e.target.position?.lineNumber ?? null
    if (ln == null || !canCommentOnLine(ln)) {
      hoverLineRef.current = null
      setDisplay('none')
      return
    }
    hoverLineRef.current = ln
    positionAtLine(ln)
  })
  // Keep hoverLineRef on mouse-leave: Monaco's content-area leave fires before the button's, so a click in that gap still resolves to the last-hovered line.
  const onMouseLeave = editor.onMouseLeave(() => {
    setDisplay('none')
  })
  const onScroll = editor.onDidScrollChange(() => {
    if (hoverLineRef.current != null) {
      positionAtLine(hoverLineRef.current)
    }
  })

  disposablesRef.current = [onMouseMove, onMouseLeave, onScroll]

  return () => {
    for (const d of disposablesRef.current) {
      d.dispose()
    }
    disposablesRef.current = []
    document.removeEventListener('mousemove', handleRangeDragMove)
    document.removeEventListener('mouseup', finishRangeDrag)
    clearRangeDecoration()
    plus.removeEventListener('mousedown', handleMouseDown)
    plus.remove()
  }
}
