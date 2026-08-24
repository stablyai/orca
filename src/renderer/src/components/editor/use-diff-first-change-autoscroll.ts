import { useEffect, useRef, type MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import { diffViewStateCache } from '@/lib/scroll-cache'

// Why: center the first diff from a dedicated effect (not handleMount) so it
// runs after the comment decorator's view zones, which would otherwise shift
// content downward.
export function useDiffFirstChangeAutoScroll(args: {
  diffEditorRef: MutableRefObject<editor.IStandaloneDiffEditor | null>
  modifiedEditor: editor.ICodeEditor | null
  modelKey: string
  /** Non-null when the decorator owns the initial scroll (scroll-to-note). */
  pendingScrollForThisViewer: string | null
}): void {
  const { diffEditorRef, modifiedEditor, modelKey, pendingScrollForThisViewer } = args
  const didAutoScrollFirstDiffRef = useRef(false)
  const didAutoScrollModelKeyRef = useRef(modelKey)
  useEffect(() => {
    if (didAutoScrollModelKeyRef.current !== modelKey) {
      didAutoScrollModelKeyRef.current = modelKey
      // Why: reset the per-modelKey one-shot here before the first-diff guard runs for the new file.
      didAutoScrollFirstDiffRef.current = false
    }
    const diffEditor = diffEditorRef.current
    if (!diffEditor || !modifiedEditor) {
      return
    }
    if (didAutoScrollFirstDiffRef.current) {
      return
    }
    if (diffViewStateCache.get(modelKey)) {
      return
    }
    if (pendingScrollForThisViewer) {
      // Why: decorator owns this scroll, so set the one-shot flag; else we'd re-run and overwrite it when pendingScroll flips back to null.
      didAutoScrollFirstDiffRef.current = true
      return
    }
    let rafId: number | null = null
    const run = (): void => {
      if (didAutoScrollFirstDiffRef.current) {
        return
      }
      const changes = diffEditor.getLineChanges()
      if (!changes || changes.length === 0) {
        return
      }
      const line = Math.max(1, changes[0].modifiedStartLineNumber)
      // Defer one frame so view zones are laid out before measuring; cancel any earlier rAF to avoid a redundant scroll.
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (didAutoScrollFirstDiffRef.current || !modifiedEditor.getModel()) {
          return
        }
        const top = modifiedEditor.getTopForLineNumber(line, true)
        const editorHeight = modifiedEditor.getLayoutInfo().height
        modifiedEditor.setPosition({ lineNumber: line, column: 1 })
        modifiedEditor.setScrollTop(Math.max(0, top - editorHeight / 2))
        didAutoScrollFirstDiffRef.current = true
      })
    }
    // Run now if the diff is ready; otherwise onDidUpdateDiff fires once the computation lands.
    if (diffEditor.getLineChanges()) {
      run()
    }
    const sub = diffEditor.onDidUpdateDiff(() => run())
    return () => {
      sub.dispose()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
    // Why: diffEditorRef is a stable ref; the editor identity change is signaled by modifiedEditor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modifiedEditor, modelKey, pendingScrollForThisViewer])
}
