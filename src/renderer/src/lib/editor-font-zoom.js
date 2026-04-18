const EDITOR_FONT_ZOOM_MIN = -6;
const EDITOR_FONT_ZOOM_MAX = 18;
const EDITOR_FONT_ZOOM_STEP = 1;
export function clampEditorFontZoomLevel(level) {
    return Math.max(EDITOR_FONT_ZOOM_MIN, Math.min(EDITOR_FONT_ZOOM_MAX, level));
}
export function nextEditorFontZoomLevel(current, direction) {
    if (direction === 'reset') {
        return 0;
    }
    if (direction === 'in') {
        return clampEditorFontZoomLevel(current + EDITOR_FONT_ZOOM_STEP);
    }
    return clampEditorFontZoomLevel(current - EDITOR_FONT_ZOOM_STEP);
}
export function computeEditorFontSize(baseFontSize, zoomLevel) {
    // Why: Monaco and markdown surfaces become unreadable or visually broken at
    // extreme values. Clamp after applying zoom so all editor-like surfaces stay
    // within the same safe range regardless of their own default base size.
    return Math.max(8, Math.min(32, baseFontSize + zoomLevel));
}
