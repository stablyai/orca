import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import type { RefObject } from 'react'
import { getDiffCommentPopoverTop } from './diff-comment-popover-position'
import { toDiffCommentLineTarget } from './diff-comment-line-range'
import {
  getGutterPressLine,
  installDiffCommentRangeDrag,
  type DiffCommentRangeDragHandle
} from './diff-comment-range-drag'

// Monaco glyph decorations don't expose usable click events, so we own an absolutely-positioned "+" button that follows the hovered line.

type AddButtonOverlayArgs = {
  editor: monacoEditor.ICodeEditor
  editorDomNode: HTMLElement
  addButtonLabel: string
  commentableLineSet: Set<number> | null
  // The hovered line survives model-swap rebuilds so a press on the parked button still has an anchor.
  hoverLineRef: RefObject<number | null>
  onAddCommentClickRef: RefObject<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >
}

export type DiffCommentAddButtonOverlayHandle = {
  dispose: () => void
  setPendingRange: DiffCommentRangeDragHandle['setPendingRange']
  isDragging: DiffCommentRangeDragHandle['isDragging']
}

export function installDiffCommentAddButtonOverlay({
  editor,
  editorDomNode,
  addButtonLabel,
  commentableLineSet,
  hoverLineRef,
  onAddCommentClickRef
}: AddButtonOverlayArgs): DiffCommentAddButtonOverlayHandle {
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
  let dragging = false

  const setDisplay = (value: string): void => {
    if (lastDisplay === value) {
      return
    }
    plus.style.display = value
    lastDisplay = value
  }

  // Fixed 18px square centered in the line box — tracking line-height made a rectangle on taller line-heights.
  const BUTTON_SIZE = 18

  const canCommentOnLine = (lineNumber: number): boolean => {
    return commentableLineSet === null || commentableLineSet.has(lineNumber)
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

  const rangeDrag = installDiffCommentRangeDrag({
    editor,
    editorDomNode,
    commentableLineSet,
    // A press on the "+" itself has no Monaco gutter target, so it resolves through the line the
    // button is parked on.
    resolvePressLine: (event) =>
      event.target instanceof Node && plus.contains(event.target)
        ? hoverLineRef.current
        : getGutterPressLine(editor, event),
    onDragChange: ({ dragging: isDragging, focusLine }) => {
      dragging = isDragging
      // Why: inert while dragging so it can't punch a hit-test hole in the band the pointer is
      // sweeping — but it still rides the growing end of the selection, which is the only thing
      // telling the user the drag is live.
      plus.style.pointerEvents = isDragging ? 'none' : ''
      editorDomNode.classList.toggle('orca-diff-comment-range-dragging', isDragging)
      if (isDragging && focusLine !== null) {
        hoverLineRef.current = focusLine
        positionAtLine(focusLine)
      }
    },
    onCommit: (range) => {
      const top = getDiffCommentPopoverTop(editor, range.endLine, getLineHeight())
      if (top == null) {
        return
      }
      onAddCommentClickRef.current({ ...toDiffCommentLineTarget(range), top })
    }
  })

  const onMouseMove = editor.onMouseMove((e) => {
    if (dragging) {
      return
    }
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
    if (!dragging) {
      setDisplay('none')
    }
  })
  const onScroll = editor.onDidScrollChange(() => {
    if (!dragging && hoverLineRef.current != null) {
      positionAtLine(hoverLineRef.current)
    }
  })

  const disposables = [onMouseMove, onMouseLeave, onScroll]

  return {
    dispose: () => {
      for (const d of disposables) {
        d.dispose()
      }
      rangeDrag.dispose()
      editorDomNode.classList.remove('orca-diff-comment-range-dragging')
      plus.remove()
    },
    setPendingRange: rangeDrag.setPendingRange,
    isDragging: rangeDrag.isDragging
  }
}
