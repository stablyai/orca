import { useLayoutEffect, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { Selection } from '@tiptap/pm/state'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { captureEditorView, registerEditorView } from './editor-view-transfer'

export function useRichMarkdownViewTransfer(
  editor: Editor | null,
  viewId: string,
  scrollCacheKey: string,
  scroll: RefObject<HTMLDivElement | null>,
  readText: () => string
): void {
  useLayoutEffect(() => {
    if (!editor) {
      return
    }
    const transferred = captureEditorView(viewId)
    if (transferred?.rich) {
      editor.view.dispatch(
        editor.state.tr.setSelection(
          Selection.fromJSON(editor.state.doc, transferred.rich.selection)
        )
      )
      setWithLRU(scrollTopCache, scrollCacheKey, transferred.rich.scrollTop)
    }
    let version = transferred?.version ?? 0
    const changed = (): void => {
      version++
    }
    editor.on('update', changed)
    const unregister = registerEditorView(viewId, () => ({
      text: readText(),
      version,
      state: null,
      rich: {
        selection: editor.state.selection.toJSON(),
        scrollTop: scroll.current?.scrollTop ?? 0
      }
    }))
    return () => {
      unregister()
      editor.off('update', changed)
    }
  }, [editor, viewId, scrollCacheKey, scroll, readText])
}
