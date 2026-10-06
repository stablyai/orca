import type { Editor } from '@tiptap/react'
import type { Transaction } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { getRichMarkdownImageResolverContextVersion } from './rich-markdown-image-context'
import {
  captureRichMarkdownClipboardInsertionOrder,
  richMarkdownClipboardInsertionOrderKey
} from './rich-markdown-clipboard-insertion-order'

export type RichMarkdownImageInsertionRange = {
  from: number
  to: number
  requestOrder: number
  cellSelection?: CellSelection
}

export type RichMarkdownImageInsertionTarget = {
  getRange: () => RichMarkdownImageInsertionRange | null
  dispose: () => void
}

export function captureRichMarkdownImageInsertionTarget(
  editor: Editor
): RichMarkdownImageInsertionTarget | null {
  if (editor.isDestroyed || !editor.view.dom.isConnected || !editor.isEditable) {
    return null
  }
  const targetDom = editor.view.dom
  const contextVersion = getRichMarkdownImageResolverContextVersion(editor)
  const requestOrder = captureRichMarkdownClipboardInsertionOrder(editor)
  let cellSelection =
    editor.state.selection instanceof CellSelection && editor.state.selection.ranges.length > 1
      ? editor.state.selection
      : null
  let ranges = editor.state.selection.ranges.map(({ $from, $to }) => ({
    from: $from.pos,
    to: $to.pos
  }))
  let document = editor.state.doc
  let active = true

  const dispose = (): void => {
    if (!active) {
      return
    }
    active = false
    editor.off('transaction', mapTransactions)
    editor.off('destroy', dispose)
  }

  const mapTransactions = ({
    transaction,
    appendedTransactions
  }: {
    transaction: Transaction
    appendedTransactions: Transaction[]
  }): void => {
    const transactions = [transaction, ...appendedTransactions]
    const nextDocument = appendedTransactions.at(-1)?.doc ?? transaction.doc
    if (nextDocument.eq(document)) {
      document = nextDocument
      return
    }
    if (!transaction.before.eq(document)) {
      dispose()
      return
    }
    const insertionOrder: unknown = transaction.getMeta(richMarkdownClipboardInsertionOrderKey)
    for (const nextTransaction of transactions) {
      for (const map of nextTransaction.mapping.maps) {
        const mappedRanges: { from: number; to: number }[] = []
        for (const range of ranges) {
          const collapsed = range.from === range.to
          let overlapsSelection = false
          if (!collapsed) {
            map.forEach((from, to) => {
              overlapsSelection ||=
                to > from
                  ? from < range.to && to > range.from
                  : cellSelection
                    ? from >= range.from && from <= range.to
                    : from > range.from && from < range.to
            })
          }
          if (overlapsSelection) {
            dispose()
            return
          }
          // Pending pastes keep their request order, ahead of later ordinary typing.
          const assoc = typeof insertionOrder === 'number' && insertionOrder < requestOrder ? 1 : -1
          const from = map.mapResult(range.from, collapsed ? assoc : 1)
          const to = map.mapResult(range.to, collapsed ? assoc : -1)
          if (from.deletedAcross || to.deletedAcross || from.pos > to.pos) {
            dispose()
            return
          }
          mappedRanges.push({ from: from.pos, to: to.pos })
        }
        ranges = mappedRanges
      }
      if (cellSelection) {
        const mapped = cellSelection.map(nextTransaction.doc, nextTransaction.mapping)
        if (
          !(mapped instanceof CellSelection) ||
          mapped.ranges.length !== ranges.length ||
          mapped.ranges.some(
            ({ $from, $to }, index) =>
              $from.pos !== ranges[index].from || $to.pos !== ranges[index].to
          )
        ) {
          dispose()
          return
        }
        cellSelection = mapped
      }
    }
    document = nextDocument
  }

  editor.on('transaction', mapTransactions)
  editor.on('destroy', dispose)

  return {
    dispose,
    getRange: () =>
      active &&
      !editor.isDestroyed &&
      editor.isEditable &&
      editor.view.dom === targetDom &&
      targetDom.isConnected &&
      getRichMarkdownImageResolverContextVersion(editor) === contextVersion &&
      editor.state.doc.eq(document)
        ? { ...ranges[0], requestOrder, ...(cellSelection ? { cellSelection } : {}) }
        : null
  }
}
