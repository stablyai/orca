/** Page-level metadata captured at selection time. */
export type BrowserGrabPageContext = {
    sanitizedUrl: string;
    title: string;
    viewportWidth: number;
    viewportHeight: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
    capturedAt: string;
};
/** Accessibility metadata for the selected element. */
export type BrowserGrabAccessibility = {
    role: string | null;
    accessibleName: string | null;
    ariaLabel: string | null;
    ariaLabelledBy: string | null;
};
/** Curated subset of computed styles. */
export type BrowserGrabComputedStyles = {
    display: string;
    position: string;
    width: string;
    height: string;
    margin: string;
    padding: string;
    color: string;
    backgroundColor: string;
    border: string;
    borderRadius: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    textAlign: string;
    zIndex: string;
};
/** Viewport-relative or page-relative rectangle in CSS pixels. */
export type BrowserGrabRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};
/** The selected element's extracted data. */
export type BrowserGrabTarget = {
    tagName: string;
    selector: string;
    textSnippet: string;
    htmlSnippet: string;
    attributes: Record<string, string>;
    accessibility: BrowserGrabAccessibility;
    rectViewport: BrowserGrabRect;
    rectPage: BrowserGrabRect;
    computedStyles: BrowserGrabComputedStyles;
};
/** Screenshot attachment — always PNG, either a data URL or a temp file path. */
export type BrowserGrabScreenshot = {
    mimeType: 'image/png';
    dataUrl: string;
    width: number;
    height: number;
};
/** The full payload extracted from a browser grab selection. */
export type BrowserGrabPayload = {
    page: BrowserGrabPageContext;
    target: BrowserGrabTarget;
    nearbyText: string[];
    ancestorPath: string[];
    screenshot: BrowserGrabScreenshot | null;
};
/** Why a grab operation was cancelled before the user selected an element. */
export type BrowserGrabCancelReason = 'user' | 'tab-inactive' | 'navigation' | 'evicted' | 'timeout';
/** Discriminated union for the result of a single grab operation. */
export type BrowserGrabResult = {
    opId: string;
    kind: 'selected';
    payload: BrowserGrabPayload;
} | {
    opId: string;
    kind: 'context-selected';
    payload: BrowserGrabPayload;
} | {
    opId: string;
    kind: 'cancelled';
    reason: BrowserGrabCancelReason;
} | {
    opId: string;
    kind: 'error';
    reason: string;
};
export type BrowserSetGrabModeArgs = {
    browserPageId: string;
    enabled: boolean;
};
/** Why a grab IPC call was rejected before the operation could start. */
export type BrowserGrabRejectReason = 'not-ready' | 'not-authorized' | 'already-active';
export type BrowserSetGrabModeResult = {
    ok: true;
} | {
    ok: false;
    reason: BrowserGrabRejectReason;
};
export type BrowserAwaitGrabSelectionArgs = {
    browserPageId: string;
    opId: string;
};
export type BrowserCancelGrabArgs = {
    browserPageId: string;
};
export type BrowserCaptureSelectionScreenshotArgs = {
    browserPageId: string;
    rect: BrowserGrabRect;
};
export type BrowserCaptureSelectionScreenshotResult = {
    ok: true;
    screenshot: BrowserGrabScreenshot;
} | {
    ok: false;
    reason: string;
};
export type BrowserExtractHoverArgs = {
    browserPageId: string;
};
export type BrowserExtractHoverResult = {
    ok: true;
    payload: BrowserGrabPayload;
} | {
    ok: false;
    reason: string;
};
export declare const GRAB_BUDGET: {
    readonly textSnippetMaxLength: 200;
    readonly nearbyTextEntryMaxLength: 200;
    readonly nearbyTextMaxEntries: 10;
    readonly htmlSnippetMaxLength: 4096;
    readonly ancestorPathMaxEntries: 10;
    /** Hard byte budget for screenshot PNG data URL before we omit the screenshot. */
    readonly screenshotMaxBytes: number;
};
/** Only these attribute names are included in the payload by default. */
export declare const GRAB_SAFE_ATTRIBUTE_NAMES: Set<string>;
/** Attribute names matching aria-* are always included. */
export declare function isAriaAttribute(name: string): boolean;
/**
 * Patterns in attribute values that indicate secrets — these values get
 * redacted. Why tighter patterns than broad words like 'code' or 'state':
 * those match normal CSS class names (e.g. 'source-code', 'stateful') and
 * would visibly degrade extraction quality on most real-world sites. The
 * intent is to catch OAuth callback params and credential-like values.
 */
export declare const GRAB_SECRET_PATTERNS: string[];
/** Computed style properties to extract — matches BrowserGrabComputedStyles keys. */
export declare const GRAB_STYLE_PROPERTIES: readonly (keyof BrowserGrabComputedStyles)[];
