export declare function rememberLiveBrowserUrl(browserTabId: string, url: string): void;
export declare function getLiveBrowserUrl(browserTabId: string): string | null;
export declare function clearLiveBrowserUrl(browserTabId: string): void;
export declare function markEvictedBrowserTab(browserTabId: string): void;
export declare function consumeEvictedBrowserTab(browserTabId: string): boolean;
