import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { RichMarkdownContextMenuTableTarget } from '../../../../shared/rich-markdown-context-menu'
import { isRichMarkdownTableContextCommand } from './rich-markdown-context-command-routing'
import {
  richMarkdownTableCellPositionAtElement,
  runRichMarkdownTableAction
} from './rich-markdown-table-actions'

type CapturedTableTarget = RichMarkdownContextMenuTableTarget & { cellPosition: number }

let nextTableContextTargetId = 0

function createTableContextTargetId(): string {
  nextTableContextTargetId += 1
  return `rich-markdown-table-${nextTableContextTargetId}`
}

export function useRichMarkdownTableContextMenu(editor: Editor | null): void {
  const [targetId] = useState(createTableContextTargetId)
  const capturedTargetRef = useRef<CapturedTableTarget | null>(null)

  useEffect(() => {
    if (!editor) {
      return
    }
    const editorDom = editor.view.dom
    const captureTarget = (event: MouseEvent): void => {
      const cell =
        event.target instanceof Element
          ? event.target.closest<HTMLTableCellElement>('td, th')
          : null
      const cellPosition =
        cell && editorDom.contains(cell)
          ? richMarkdownTableCellPositionAtElement(editor, cell)
          : null
      if (!cell || cellPosition === null) {
        capturedTargetRef.current = null
        window.api.ui.setRichMarkdownContextMenuTarget(null)
        return
      }
      const tableTarget: RichMarkdownContextMenuTableTarget = {
        cellType: cell.tagName === 'TH' ? 'header' : 'body',
        targetId,
        x: event.clientX,
        y: event.clientY
      }
      capturedTargetRef.current = { ...tableTarget, cellPosition }
      window.api.ui.setRichMarkdownContextMenuTarget(tableTarget)
    }
    const capturePointerTarget = (event: PointerEvent): void => {
      if (event.button === 2) {
        captureTarget(event)
      }
    }
    const unsubscribe = window.api.ui.onRichMarkdownContextCommand((payload) => {
      if (!isRichMarkdownTableContextCommand(payload.command)) {
        return
      }
      const target = capturedTargetRef.current
      capturedTargetRef.current = null
      if (
        !target ||
        payload.tableTargetId !== targetId ||
        payload.x !== target.x ||
        payload.y !== target.y
      ) {
        return
      }
      runRichMarkdownTableAction(editor, payload.command, { cellPosition: target.cellPosition })
    })
    editorDom.addEventListener('pointerdown', capturePointerTarget)
    editorDom.addEventListener('contextmenu', captureTarget)
    return () => {
      editorDom.removeEventListener('pointerdown', capturePointerTarget)
      editorDom.removeEventListener('contextmenu', captureTarget)
      unsubscribe()
    }
  }, [editor, targetId])
}
