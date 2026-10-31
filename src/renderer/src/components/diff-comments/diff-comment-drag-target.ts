import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import { getCombinedDiffCodeRect } from '../editor/combined-diff-slice-geometry'

// Claim line numbers only: decoration presses toggle folds. The external add button resolves separately.
const GUTTER_PRESS_TARGET_TYPES: ReadonlySet<monacoEditor.MouseTargetType> = new Set([
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
])

// Far enough into the text column to clear the gutter, close enough to stay on every line.
const CONTENT_PROBE_INSET_PX = 4

export function getGutterPressLine(
  editor: Pick<monacoEditor.ICodeEditor, 'getTargetAtClientPoint'>,
  event: PointerEvent
): number | null {
  const target = editor.getTargetAtClientPoint(event.clientX, event.clientY)
  if (!target || !GUTTER_PRESS_TARGET_TYPES.has(target.type)) {
    return null
  }
  return target.position?.lineNumber ?? null
}

// Probe inside the text column: Monaco cannot resolve positions over the external add button.
export function getLineAtViewportY(
  editor: Pick<monacoEditor.ICodeEditor, 'getModel' | 'getLayoutInfo' | 'getTargetAtClientPoint'>,
  editorDomNode: HTMLElement,
  clientY: number
): number | null {
  const model = editor.getModel()
  if (!model) {
    return null
  }
  const visible = getCombinedDiffCodeRect(editorDomNode)
  if (!visible.width || !visible.height) {
    return null
  }
  const probeX = Math.max(
    visible.left + 1,
    Math.min(
      visible.right - 1,
      editorDomNode.getBoundingClientRect().left +
        editor.getLayoutInfo().contentLeft +
        CONTENT_PROBE_INSET_PX
    )
  )
  const line = editor.getTargetAtClientPoint(probeX, clientY)?.position?.lineNumber
  return line == null ? null : Math.max(1, Math.min(model.getLineCount(), line))
}
