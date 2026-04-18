export type BrowserFocusTarget = 'webview' | 'address-bar';
export type BrowserFocusRequestDetail = {
    pageId: string;
    target: BrowserFocusTarget;
};
export declare const ORCA_BROWSER_FOCUS_REQUEST_EVENT = "orca:browser-focus-request";
export declare function queueBrowserFocusRequest(detail: BrowserFocusRequestDetail): void;
export declare function consumeBrowserFocusRequest(pageId: string): BrowserFocusTarget | null;
