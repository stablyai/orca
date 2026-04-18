export type BrowserPermissionDeniedEvent = {
    browserPageId: string;
    /** Electron permission string (e.g. "media", "notifications"). */
    permission: string;
    /** Sanitized to origin/host so auth query params never leak into UI state. */
    origin: string;
};
export type BrowserPopupEvent = {
    browserPageId: string;
    /** Sanitized to origin/host so auth query params never leak into UI state. */
    origin: string;
    /** Whether Orca opened the target in Orca, opened it externally, or blocked it as unsafe. */
    action: 'opened-in-orca' | 'opened-external' | 'blocked';
};
export type BrowserDownloadRequestedEvent = {
    browserPageId: string;
    downloadId: string;
    /** Sanitized to origin/host so auth query params never leak into UI state. */
    origin: string;
    filename: string;
    totalBytes: number | null;
    mimeType: string | null;
};
export type BrowserDownloadProgressEvent = {
    downloadId: string;
    receivedBytes: number;
    totalBytes: number | null;
};
export type BrowserDownloadFinishedEvent = {
    downloadId: string;
    status: 'completed' | 'canceled' | 'failed';
    savePath: string | null;
    /** Human-readable UI copy only; must never contain secrets. */
    error: string | null;
};
export type BrowserContextMenuRequestedEvent = {
    browserPageId: string;
    x: number;
    y: number;
    screenX: number;
    screenY: number;
    pageUrl: string;
    linkUrl: string | null;
    canGoBack: boolean;
    canGoForward: boolean;
};
export type BrowserContextMenuDismissedEvent = {
    browserPageId: string;
};
