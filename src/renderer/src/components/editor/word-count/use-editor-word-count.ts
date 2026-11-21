import { useEffect } from 'react'
import type { editor } from 'monaco-editor'
import type { Editor } from '@tiptap/react'
import { createEditorWordCounter } from './editor-word-count'
import { useEditorWordCountStore } from './EditorWordCount'

export function useMonacoWordCount(instance: editor.IStandaloneCodeEditor | null, fileId: string) {
  const store = useEditorWordCountStore(fileId)
  useEffect(() => {
    if (!instance || !store) {
      return
    }
    const read = createEditorWordCounter({
      getDocumentVersion: () => {
        const model = instance.getModel()
        return `${model?.uri.toString()}:${model?.getVersionId()}`
      },
      getDocumentLength: () => instance.getModel()?.getValueLength() ?? 0,
      getDocumentText: () => instance.getModel()?.getValue() ?? '',
      getSelectedText: () => {
        const model = instance.getModel()
        if (!model) {
          return []
        }
        const ranges = (instance.getSelections() ?? [])
          .filter((selection) => !selection.isEmpty())
          .map((selection) => ({
            start: model.getOffsetAt(selection.getStartPosition()),
            end: model.getOffsetAt(selection.getEndPosition())
          }))
          .sort((a, b) => a.start - b.start)
        const merged: typeof ranges = []
        for (const range of ranges) {
          const previous = merged.at(-1)
          if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end)
          } else {
            merged.push({ ...range })
          }
        }
        return merged.map(({ start, end }) => {
          const from = model.getPositionAt(start)
          const to = model.getPositionAt(end)
          return model.getValueInRange({
            startLineNumber: from.lineNumber,
            startColumn: from.column,
            endLineNumber: to.lineNumber,
            endColumn: to.column
          })
        })
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      clearTimeout(timer)
      timer = setTimeout(() => store.publish(read()), 75)
    }
    const subscriptions = [
      instance.onDidChangeCursorSelection(update),
      instance.onDidChangeModelContent(update),
      instance.onDidChangeModel(update)
    ]
    store.publish(read())
    return () => {
      clearTimeout(timer)
      for (const subscription of subscriptions) {
        subscription.dispose()
      }
      store.publish(null)
    }
  }, [instance, store])
}

export function useRichMarkdownWordCount(instance: Editor | null, fileId: string) {
  const store = useEditorWordCountStore(fileId)
  useEffect(() => {
    if (!instance || !store) {
      return
    }
    const read = createEditorWordCounter({
      getDocumentVersion: () => instance.state.doc,
      getDocumentLength: () => instance.state.doc.content.size,
      getDocumentText: () =>
        instance.state.doc.textBetween(0, instance.state.doc.content.size, ' ', ' '),
      getSelectedText: () => {
        const { selection, doc } = instance.state
        return selection.empty
          ? []
          : selection.ranges.map(({ $from, $to }) => doc.textBetween($from.pos, $to.pos, ' ', ' '))
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      clearTimeout(timer)
      timer = setTimeout(() => store.publish(read()), 75)
    }
    instance.on('transaction', update)
    store.publish(read())
    return () => {
      clearTimeout(timer)
      instance.off('transaction', update)
      store.publish(null)
    }
  }, [instance, store])
}
