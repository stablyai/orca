import type { EditorTextDirection } from '../../../../shared/editor-text-direction'

/**
 * Monaco 0.55 exposes no direction option, so direction ships as a container class
 * whose CSS is scoped to rendered lines (gutter, minimap and scrollbar stay LTR).
 */
export function buildEditorTextDirectionClass(direction: EditorTextDirection): string {
  if (direction === 'rtl') {
    return 'editor-dir-rtl'
  }
  return direction === 'auto' ? 'editor-dir-auto' : ''
}
