// ---------------------------------------------------------------------------
// Browser Context Grab — shared types
//
// These types define the contract between main, preload, and renderer for the
// browser grab feature. The payload shape follows the design doc's extracted
// content model, including redaction and budget constraints.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Payload budgets — enforced in both guest and main
// ---------------------------------------------------------------------------
export const GRAB_BUDGET = {
    textSnippetMaxLength: 200,
    nearbyTextEntryMaxLength: 200,
    nearbyTextMaxEntries: 10,
    htmlSnippetMaxLength: 4096,
    ancestorPathMaxEntries: 10,
    /** Hard byte budget for screenshot PNG data URL before we omit the screenshot. */
    screenshotMaxBytes: 2 * 1024 * 1024
};
// ---------------------------------------------------------------------------
// Attribute allowlist for safe preview
// ---------------------------------------------------------------------------
/** Only these attribute names are included in the payload by default. */
export const GRAB_SAFE_ATTRIBUTE_NAMES = new Set([
    'id',
    'class',
    'name',
    'type',
    'role',
    'href',
    'src',
    'alt',
    'title',
    'placeholder',
    'for',
    'action',
    'method'
]);
/** Attribute names matching aria-* are always included. */
export function isAriaAttribute(name) {
    return name.startsWith('aria-');
}
/**
 * Patterns in attribute values that indicate secrets — these values get
 * redacted. Why tighter patterns than broad words like 'code' or 'state':
 * those match normal CSS class names (e.g. 'source-code', 'stateful') and
 * would visibly degrade extraction quality on most real-world sites. The
 * intent is to catch OAuth callback params and credential-like values.
 */
export const GRAB_SECRET_PATTERNS = [
    'access_token',
    'auth_token',
    'api_key',
    'apikey',
    'client_secret',
    'oauth_state',
    'x-amz-',
    'session_id',
    'sessionid',
    'csrf',
    'secret',
    'password',
    'passwd'
];
/** Computed style properties to extract — matches BrowserGrabComputedStyles keys. */
export const GRAB_STYLE_PROPERTIES = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'color',
    'backgroundColor',
    'border',
    'borderRadius',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'textAlign',
    'zIndex'
];
