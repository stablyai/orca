const liveBrowserUrlByTabId = new Map();
const evictedBrowserTabIds = new Set();
export function rememberLiveBrowserUrl(browserTabId, url) {
    liveBrowserUrlByTabId.set(browserTabId, url);
}
export function getLiveBrowserUrl(browserTabId) {
    return liveBrowserUrlByTabId.get(browserTabId) ?? null;
}
export function clearLiveBrowserUrl(browserTabId) {
    liveBrowserUrlByTabId.delete(browserTabId);
}
export function markEvictedBrowserTab(browserTabId) {
    evictedBrowserTabIds.add(browserTabId);
}
export function consumeEvictedBrowserTab(browserTabId) {
    const wasEvicted = evictedBrowserTabIds.has(browserTabId);
    if (wasEvicted) {
        evictedBrowserTabIds.delete(browserTabId);
    }
    return wasEvicted;
}
