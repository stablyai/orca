// Why: EditorPanel and its Monaco/TipTap children are React.lazy chunks that
// were only fetched at click time, so the first file open showed
// "Loading editor…" through a three-stage waterfall (panel chunk → editor
// chunk → file read). Warming them at idle makes the first open feel native.
const warm = (): void => {
  void import('./EditorPanel')
  void import('./MonacoEditor')
  void import('./RichMarkdownEditor')
  void import('./MarkdownPreview')
}

export function prefetchEditorChunks(): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(warm, { timeout: 3000 })
  } else {
    setTimeout(warm, 1500)
  }
}
