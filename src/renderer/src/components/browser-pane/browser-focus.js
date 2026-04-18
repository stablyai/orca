export const ORCA_BROWSER_FOCUS_REQUEST_EVENT = 'orca:browser-focus-request';
const pendingBrowserFocusByPageId = new Map();
export function queueBrowserFocusRequest(detail) {
    pendingBrowserFocusByPageId.set(detail.pageId, detail.target);
}
export function consumeBrowserFocusRequest(pageId) {
    const pending = pendingBrowserFocusByPageId.get(pageId) ?? null;
    if (!pending) {
        return null;
    }
    pendingBrowserFocusByPageId.delete(pageId);
    return pending;
}
