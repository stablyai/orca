import { useEffect, useLayoutEffect, useRef, type ClipboardEvent } from 'react'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { copyCsvSelection, pasteCsvSelection } from './csv-cell-clipboard'
import type { CsvCellSelection } from './csv-cell-selection'
import type { CsvCellEditSession } from './csv-grid-interaction'
import type { CsvCellEdit, CsvTextDocument } from './csv-text-document'

export function useCsvClipboard({
  document,
  selection,
  editing,
  columns,
  inspectionRows,
  ownerId,
  apply,
  fail
}: {
  document: CsvTextDocument | null
  selection: CsvCellSelection | null
  editing: CsvCellEditSession | null
  columns: number
  inspectionRows: number[] | null
  ownerId: string
  apply: (edits: CsvCellEdit[]) => boolean
  fail: (reason: unknown) => void
}) {
  const mounted = useRef(true)
  const revision = useRef(0)
  useLayoutEffect(() => {
    revision.current += 1
  }, [
    document,
    inspectionRows,
    editing,
    selection?.anchor.row,
    selection?.anchor.column,
    selection?.focus.row,
    selection?.focus.column
  ])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const pasteText = (text: string): void => {
    if (!document || !selection) {
      return
    }
    try {
      apply(pasteCsvSelection(text, selection, document.rows, columns, inspectionRows))
    } catch (reason) {
      fail(reason)
    }
  }
  const ownsFocus = (): boolean =>
    globalThis.document.activeElement?.getAttribute('data-csv-owner') === ownerId
  const paste = async (requireOwnerFocus = false): Promise<void> => {
    if (!document || !selection) {
      return
    }
    const initialRevision = revision.current
    try {
      const text = await window.api.ui.readClipboardText()
      if (!mounted.current || (requireOwnerFocus && !ownsFocus())) {
        return
      }
      if (initialRevision !== revision.current) {
        throw new Error('CSV changed before paste completed. Try again.')
      }
      pasteText(text)
    } catch (reason) {
      if (mounted.current) {
        fail(reason)
      }
    }
  }
  const copy = async (): Promise<void> => {
    if (!document || !selection) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(
        copyCsvSelection(selection, document.rows, inspectionRows)
      )
    } catch (reason) {
      if (mounted.current) {
        fail(reason)
      }
    }
  }
  const copyEvent = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (!document || !selection || event.target !== event.currentTarget) {
      return
    }
    event.preventDefault()
    try {
      event.clipboardData.setData(
        'text/plain',
        copyCsvSelection(selection, document.rows, inspectionRows)
      )
    } catch (reason) {
      fail(reason)
    }
  }
  const pasteEvent = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) {
      return
    }
    event.preventDefault()
    pasteText(event.clipboardData.getData('text/plain'))
  }
  useEffect(() => {
    const handle = (event: Event): void => {
      if (document && selection && ownsFocus()) {
        event.preventDefault()
        void paste(true)
      }
    }
    window.addEventListener(APP_MENU_PASTE_EVENT, handle)
    return () => window.removeEventListener(APP_MENU_PASTE_EVENT, handle)
  })
  return { pasteText, paste, copy, copyEvent, pasteEvent }
}
