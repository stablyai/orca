export const ZOOM_LEVEL_CHANGED_EVENT = 'orca:zoom-level-changed';
export function dispatchZoomLevelChanged(type, percent) {
    window.dispatchEvent(new CustomEvent(ZOOM_LEVEL_CHANGED_EVENT, {
        detail: { type, percent }
    }));
}
