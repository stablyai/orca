import type { editor } from 'monaco-editor'
import {
  COMBINED_DIFF_VIEWPORT_SELECTOR,
  COMBINED_DIFF_ROW_SELECTOR,
  COMBINED_DIFF_HEADER_SELECTOR
} from './combined-diff-viewport'
import { hasLayoutBox } from '@/hooks/virtualized-hidden-row-measurement'

export function installCombinedDiffCursorReveal(diff: editor.IStandaloneDiffEditor): () => void {
  const root = diff.getContainerDomNode()
  const viewport = root.closest<HTMLElement>(COMBINED_DIFF_VIEWPORT_SELECTOR)
  if (!viewport) {
    return () => {}
  }
  const header = root
    .closest(COMBINED_DIFF_ROW_SELECTOR)
    ?.querySelector<HTMLElement>(COMBINED_DIFF_HEADER_SELECTOR)
  const subscriptions = [diff.getOriginalEditor(), diff.getModifiedEditor()].map((pane) =>
    pane.onDidChangeCursorPosition((event) => {
      const node = pane.getContainerDomNode()
      if (event.source !== 'keyboard' || !node || !hasLayoutBox(node) || !hasLayoutBox(viewport)) {
        return
      }
      const cursor = pane.getScrolledVisiblePosition(event.position)
      if (!cursor) {
        return
      }
      const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
      const top = node.getBoundingClientRect().top + cursor.top
      const visibleTop = viewportTop + (header?.getBoundingClientRect().height ?? 0)
      const visibleBottom = viewportTop + viewport.clientHeight
      const delta =
        top < visibleTop ? top - visibleTop : Math.max(0, top + cursor.height - visibleBottom)
      // Keyboard reveals are user intent; unmarked scrolls update the existing outer anchor.
      if (delta !== 0) {
        viewport.scrollTop += delta
      }
    })
  )
  return () => subscriptions.forEach((subscription) => subscription.dispose())
}
