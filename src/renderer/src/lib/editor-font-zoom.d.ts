export type EditorZoomDirection = 'in' | 'out' | 'reset';
export declare function clampEditorFontZoomLevel(level: number): number;
export declare function nextEditorFontZoomLevel(current: number, direction: EditorZoomDirection): number;
export declare function computeEditorFontSize(baseFontSize: number, zoomLevel: number): number;
