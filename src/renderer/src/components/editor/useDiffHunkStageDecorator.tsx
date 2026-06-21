import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import type { DiffHunk } from '../../../../shared/git-hunk-patch'

/** Reveals a stage/unstage pill on hover over a hunk, pinned to the editor's
 * right edge — absolute (not a view zone) so it stays out of the layout. */

const BTN_HEIGHT = 18

type DiffHunkStageDecoratorArgs = {
  editor: monacoEditor.ICodeEditor | null
  hunks: readonly DiffHunk[]
  label: string
  /** Disabled while an apply is in flight so a hunk isn't double-submitted. */
  disabled: boolean
  onApplyHunk: (hunkIndex: number) => void
}

export function useDiffHunkStageDecorator({
  editor,
  hunks,
  label,
  disabled,
  onApplyHunk
}: DiffHunkStageDecoratorArgs): void {
  const onApplyHunkRef = useRef(onApplyHunk)
  onApplyHunkRef.current = onApplyHunk
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const hunksRef = useRef(hunks)
  hunksRef.current = hunks
  const labelRef = useRef(label)
  labelRef.current = label

  useEffect(() => {
    if (!editor) {
      return
    }
    const host = editor.getDomNode()
    if (!host) {
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'orca-diff-hunk-stage-btn'
    button.style.position = 'absolute'
    button.style.right = '16px'
    button.style.zIndex = '6'
    button.style.display = 'none'
    host.appendChild(button)
    let activeHunk = -1

    const lineHeight = (): number => editor.getOption(monaco.editor.EditorOption.lineHeight) || 19
    const hunkForLine = (line: number): DiffHunk | undefined =>
      hunksRef.current.find(
        (h) => line >= h.newStart && line < h.newStart + Math.max(1, h.newLineCount)
      )

    const showAtLine = (line: number, hunk: DiffHunk): void => {
      const top = editor.getTopForLineNumber(line) - editor.getScrollTop()
      button.style.top = `${Math.round(top + (lineHeight() - BTN_HEIGHT) / 2)}px`
      button.textContent = labelRef.current
      button.disabled = disabledRef.current
      button.style.display = 'inline-flex'
      activeHunk = hunk.index
    }
    const hide = (): void => {
      button.style.display = 'none'
      activeHunk = -1
    }

    const onMove = editor.onMouseMove((e) => {
      const src = e.event?.browserEvent as MouseEvent | undefined
      if (src && button.contains(src.target as Node)) {
        return
      }
      const line = e.target.position?.lineNumber
      const hunk = line == null ? undefined : hunkForLine(line)
      if (line == null || !hunk) {
        hide()
        return
      }
      showAtLine(line, hunk)
    })
    const onLeave = editor.onMouseLeave(() => hide())
    const onScroll = editor.onDidScrollChange(() => {
      if (activeHunk < 0) {
        return
      }
      const hunk = hunksRef.current.find((h) => h.index === activeHunk)
      if (hunk) {
        showAtLine(hunk.newStart, hunk)
      }
    })

    button.addEventListener('mousedown', (ev) => ev.stopPropagation())
    button.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (disabledRef.current || activeHunk < 0) {
        return
      }
      onApplyHunkRef.current(activeHunk)
    })

    return () => {
      onMove.dispose()
      onLeave.dispose()
      onScroll.dispose()
      button.remove()
    }
  }, [editor])
}
