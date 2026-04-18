/**
 * Apply a UI zoom level change: sets webFrame zoom via the preload API,
 * updates the CSS variable used to compensate the traffic-light pad,
 * and repositions the native macOS traffic lights to stay aligned.
 */
export declare function applyUIZoom(level: number): void;
/**
 * Sync the CSS variable with the current webFrame zoom level.
 * Call on startup after the main process has restored the zoom.
 */
export declare function syncZoomCSSVar(): void;
