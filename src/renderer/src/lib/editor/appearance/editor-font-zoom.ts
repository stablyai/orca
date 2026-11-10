// Why shared: main resolves the editor font size for plugins with the same rule.
export {
  clampEditorFontZoomLevel,
  computeDiffEditorFontSize,
  computeEditorFontSize,
  nextEditorFontZoomLevel,
  type EditorZoomDirection
} from '../../../../../shared/editor/editor-font-zoom'
