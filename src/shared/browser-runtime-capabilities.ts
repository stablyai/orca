// Conditional browser capabilities: getStatus() advertises each only when this host can honour it.

// Why: signals a host owns browser pages with no renderer (headless serve via the
// offscreen backend). Advertised only when that backend is actually available, so
// clients never fall back to a local desktop browser tab for a remote-owned page.
export const BROWSER_HEADLESS_RUNTIME_CAPABILITY = 'browser.headless.v1' as const
export const BROWSER_IDENTITY_RUNTIME_CAPABILITY = 'browser.identity.v1' as const
export const BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY = 'browser.certificate-trust.v1' as const
