import type { BrowserDownloadFinishedEvent, BrowserPermissionDeniedEvent, BrowserPopupEvent } from '../../../../shared/browser-guest-events';
import type { BrowserLoadError } from '../../../../shared/types';
type LoadFailureMeta = {
    host: string | null;
    isLocalhostLike: boolean;
};
type BrowserLoadErrorLike = BrowserLoadError | null;
export declare function formatPermissionNotice(event: BrowserPermissionDeniedEvent): string;
export declare function formatPopupNotice(event: BrowserPopupEvent): string;
export declare function formatDownloadFinishedNotice(event: BrowserDownloadFinishedEvent): string;
export declare function formatByteCount(bytes: number | null): string | null;
export declare function formatLoadFailureDescription(loadError: BrowserLoadErrorLike, meta: LoadFailureMeta): string;
export declare function formatLoadFailureRecoveryHint(meta: LoadFailureMeta): string | null;
export {};
